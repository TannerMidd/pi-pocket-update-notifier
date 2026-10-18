/**
 * Pocket updates checks for new stable Pi Pocket releases and tells the owner. It does not install updates or restart the server.
 */
import type { Host, Web, WebRequest } from "./_pocket.d.ts";
import {
    BACKOFF,
    CADENCE,
    COOLDOWN,
    CheckFailure,
    State,
    compareVersions,
    fetchLatest,
    initialState,
    parseVersion,
} from "./update-notifier/domain.ts";
import type { CheckResult, Status } from "./update-notifier/domain.ts";

export const pocketApi = 1;
const UNSUPPORTED =
    "Pocket updates needs Pi Pocket 0.16.0 or later with request document support. Update Pocket and restart the server.";

type Dependencies = { fetcher?: typeof fetch; now?: () => number };

// Optional dependencies are for unit tests only, never browser request parameters.
export default function setup(host: Host, web: Web, dependencies: Dependencies = {}) {
    const now = dependencies.now ?? Date.now;
    const stop = new AbortController();
    let checking = false;

    web.client("update-notifier", { access: "owner" });
    web.onDispose(() => stop.abort());

    function owner(request: WebRequest) {
        if (request.user.role !== "owner") {
            throw web.error(404, "Not found.");
        }
    }

    function supported(request: WebRequest) {
        const running = parseVersion(host.pocketVersion);

        return (
            !!running &&
            // Match the gallery minimum: a prerelease counts as its base release for API support only.
            compareVersions({ ...running, pre: [] }, parseVersion("0.16.0")!) >= 0 &&
            typeof request.snapshot === "function" &&
            typeof request.commit === "function" &&
            !!request.context?.abortSignal
        );
    }

    function requireSupport(request: WebRequest) {
        owner(request);
        if (!supported(request)) {
            throw web.error(409, UNSUPPORTED);
        }
        if (stop.signal.aborted) {
            throw web.error(503, "Pocket updates is no longer active.");
        }
    }

    async function status(request: WebRequest): Promise<Status> {
        owner(request);
        if (!supported(request)) {
            return {
                supported: false as const,
                running: host.pocketVersion ?? null,
                error: UNSUPPORTED,
            };
        }

        const state = (await request.snapshot(State, request.context)) ?? initialState();
        const running = parseVersion(host.pocketVersion)!;
        const latest = state.latest ? parseVersion(state.latest.version) : null;
        const order = latest ? compareVersions(running, latest) : null;
        const comparison =
            order === null ? "unknown" : order < 0 ? "update" : order > 0 ? "ahead" : "current";
        const time = now();
        const dismissed = !!state.latest && state.dismissedTag === state.latest.tag;

        return {
            supported: true as const,
            running: host.pocketVersion,
            latest: state.latest,
            comparison,
            prerelease: running.pre.length > 0,
            automatic: state.automatic,
            dismissed,
            badge: comparison === "update" && !dismissed,
            lastAttemptAt: state.lastAttemptAt,
            lastSuccessAt: state.lastSuccessAt,
            nextAutomaticAt: state.automatic
                ? Math.max(state.nextAutomaticAt, state.rateLimitedUntil)
                : null,
            manualAfter: Math.max(
                (state.lastAttemptAt ?? -COOLDOWN) + COOLDOWN,
                state.rateLimitedUntil,
            ),
            rateLimitedUntil: state.rateLimitedUntil > time ? state.rateLimitedUntil : null,
            checking,
            checkState: checking
                ? "checking"
                : state.error
                  ? "error"
                  : state.lastAttemptAt !== null &&
                      (state.lastSuccessAt === null || state.lastAttemptAt > state.lastSuccessAt)
                    ? "interrupted"
                    : state.lastSuccessAt !== null
                      ? "checked"
                      : "never",
            stale:
                state.lastSuccessAt !== null &&
                (time - state.lastSuccessAt >= CADENCE || state.error !== null),
            error: state.error,
        };
    }

    async function publish(request: WebRequest) {
        const value = await status(request);

        web.send("state", value, { to: request.user.id });

        return value;
    }

    async function check(request: WebRequest, manual: boolean) {
        requireSupport(request);
        if (checking) {
            // Do not borrow the first request's document context or wait for its lifetime.
            return status(request);
        }

        checking = true;
        let finalStatus: Status | undefined;

        try {
            const started = await request.commit(async (tx) => {
                const state = await tx.doc(State);
                const time = now();

                if (
                    time < state.rateLimitedUntil ||
                    (state.lastAttemptAt !== null && time < state.lastAttemptAt + COOLDOWN) ||
                    (!manual && (!state.automatic || time < state.nextAutomaticAt))
                ) {
                    return false;
                }

                // Persist before network I/O. A disconnect, reload or failed result commit cannot cause a retry storm.
                state.lastAttemptAt = time;
                state.nextAutomaticAt = time + BACKOFF;

                return true;
            });

            if (started) {
                await publish(request);
                const signal = AbortSignal.any([request.context.abortSignal!, stop.signal]);
                let result: CheckResult | undefined;
                let failure: CheckFailure | undefined;

                try {
                    result = await fetchLatest(signal, dependencies.fetcher, now);
                } catch (error) {
                    if (signal.aborted) {
                        throw error;
                    }

                    failure =
                        error instanceof CheckFailure
                            ? error
                            : new CheckFailure("The update check failed.");
                }

                // Keep commits outside the fetch catch: a storage failure is not a network error.
                await request.commit(async (tx) => {
                    const state = await tx.doc(State);
                    const time = now();

                    if (result) {
                        state.latest = result.release;
                        state.lastSuccessAt = time;
                        state.rateLimitedUntil = result.retryUntil;
                        state.nextAutomaticAt = Math.max(time + CADENCE, state.rateLimitedUntil);
                        state.error = null;
                    } else {
                        state.error = failure!.message;
                        state.rateLimitedUntil = Math.max(
                            state.rateLimitedUntil,
                            failure!.retryUntil,
                        );
                        state.nextAutomaticAt = Math.max(time + BACKOFF, state.rateLimitedUntil);
                    }
                });
            }
        } finally {
            checking = false;
            if (!request.context.abortSignal!.aborted && !stop.signal.aborted) {
                finalStatus = await publish(request);
            }
        }

        return finalStatus;
    }

    web.route("GET", "state", status, { access: "owner" });
    web.route("POST", "check-if-due", (request) => check(request, false), { access: "owner" });
    web.route("POST", "check", (request) => check(request, true), { access: "owner" });
    web.route(
        "POST",
        "settings",
        async (request) => {
            requireSupport(request);
            if (typeof request.body.automatic !== "boolean") {
                throw web.error(400, "Automatic checks must be on or off.");
            }

            await request.commit(async (tx) => {
                (await tx.doc(State)).automatic = request.body.automatic as boolean;
            });

            return publish(request);
        },
        { access: "owner" },
    );
    web.route(
        "POST",
        "dismiss",
        async (request) => {
            requireSupport(request);
            await request.commit(async (tx) => {
                const state = await tx.doc(State);

                if (!state.latest || request.body.tag !== state.latest.tag) {
                    throw web.error(
                        409,
                        "The release changed. Read the latest result and try again.",
                    );
                }

                state.dismissedTag = state.latest.tag;
            });

            return publish(request);
        },
        { access: "owner" },
    );
}
