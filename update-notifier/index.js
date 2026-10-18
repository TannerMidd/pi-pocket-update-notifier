export const pocketApi = 1;

/** @param {import("../_pocket.d.ts").Pocket} pocket */
export default function setup(pocket) {
    if (pocket.me()?.role !== "owner") {
        return;
    }

    const { html, useEffect, useState } = pocket;
    const stop = new AbortController();
    const listeners = new Set();
    const noticed = new Set();
    /** @type {import("./domain.ts").Status | null} */
    let state = null;
    let pending = false;
    let transportError = "";
    const rail = pocket.rail({
        id: "updates",
        title: "Pocket updates",
        icon: "download",
        page: "updates",
    });

    pocket.style("style.css");

    function changed() {
        for (const listener of listeners) {
            listener();
        }
    }

    /** @param {import("./domain.ts").Status} value */
    function accept(value) {
        if (stop.signal.aborted || pocket.me()?.role !== "owner") {
            return;
        }

        state = value;
        transportError = "";
        rail.update({ badge: value.supported && value.badge ? "New" : null });
        if (value.supported && value.badge && value.latest) {
            const owner = pocket.me().id;
            const release = value.latest;
            const key = `x.update-notifier.notified.${encodeURIComponent(owner)}.${encodeURIComponent(release.tag)}`;
            const notify = () => {
                if (
                    stop.signal.aborted ||
                    pocket.me()?.id !== owner ||
                    pocket.me()?.role !== "owner" ||
                    !state?.supported ||
                    !state.badge ||
                    state.latest?.tag !== release.tag ||
                    noticed.has(key)
                ) {
                    return;
                }

                noticed.add(key);
                try {
                    if (localStorage.getItem(key)) {
                        return;
                    }

                    localStorage.setItem(key, "1");
                } catch {
                    // Keep the in-memory receipt when browser storage is blocked.
                }

                pocket.notify(
                    "info",
                    `Pi Pocket ${release.version} is available. Open Pocket updates to view the release.`,
                );
            };

            // Serialize tabs where possible; LAN HTTP still gets a best-effort notice.
            if (globalThis.navigator?.locks) {
                void navigator.locks.request(key, { signal: stop.signal }, notify).catch(notify);
            } else {
                notify();
            }
        }

        changed();
    }

    async function request(path, body = undefined) {
        if (pending || stop.signal.aborted || pocket.me()?.role !== "owner") {
            return;
        }

        pending = true;
        changed();
        try {
            /** @type {import("./domain.ts").Status} */
            const value = await pocket.api(path, body, { signal: stop.signal });

            accept(value);
        } catch (error) {
            if (!stop.signal.aborted) {
                transportError = error instanceof Error ? error.message : "The request failed.";
            }
        } finally {
            pending = false;
            if (!stop.signal.aborted) {
                changed();
            }
        }
    }

    function date(value) {
        return value === null ? "Not yet" : new Date(value).toLocaleString();
    }

    function Updates() {
        const [, redraw] = useState(0);
        const [time, setTime] = useState(Date.now());

        useEffect(() => {
            const update = () => redraw((value) => value + 1);

            listeners.add(update);
            void request("state");
            const timer = setInterval(() => setTime(Date.now()), 15_000);

            return () => {
                listeners.delete(update);
                clearInterval(timer);
            };
        }, []);

        if (!state) {
            return html`<div class="x-update-notifier">
                ${
                    transportError
                        ? html`<div class="error-box" role="alert">${transportError}</div>
                              <button class="button" onClick=${() => request("state")}>
                                  Try again
                              </button>`
                        : html`<${pocket.Loader} label="Reading update status…" />`
                }
            </div>`;
        }
        if (!state.supported) {
            return html`<div class="x-update-notifier">
                <div class="error-box" role="alert">${state.error}</div>
            </div>`;
        }

        const title = {
            unknown: "No release checked yet",
            update: "A stable update is available",
            ahead: "Running ahead of the stable release",
            current: "You have the latest stable release",
        }[state.comparison];
        const tag = state.latest?.tag;
        const automatic = state.automatic;
        const busy = pending || state.checking;
        const waiting = time < state.manualAfter;
        const checkState = {
            checking: "Checking GitHub…",
            error: "The last check failed",
            interrupted: "The last check did not finish",
            checked: "The last check succeeded",
            never: "No check completed yet",
        }[state.checkState];

        return html`<div class="x-update-notifier">
            <section class="x-update-notifier-card" aria-label="Release status">
                <div class="x-update-notifier-heading">
                    <span class=${`x-update-notifier-dot ${state.badge ? "is-new" : ""}`}></span>
                    <h2>${title}</h2>
                </div>
                <dl class="x-update-notifier-versions">
                    <div>
                        <dt>Running</dt>
                        <dd class="mono">${state.running}</dd>
                    </div>
                    <div>
                        <dt>Latest stable</dt>
                        <dd class="mono">${state.latest?.version ?? "Not checked"}</dd>
                    </div>
                </dl>
                ${state.prerelease ? html`<p class="muted small">You are running a prerelease. Only stable releases are checked.</p>` : null}
                ${state.dismissed ? html`<p class="muted small">This release is dismissed. Its badge and notice are off.</p>` : null}
                <div class="x-update-notifier-actions">
                    <button
                        class="button primary"
                        disabled=${busy || waiting}
                        onClick=${() => request("check", {})}
                    >
                        ${busy ? "Checking…" : "Check now"}
                    </button>
                    ${state.latest ? html`<a class="button" href=${state.latest.url} target="_blank" rel="noopener noreferrer">View release</a>` : null}
                    ${
                        state.comparison === "update" && !state.dismissed
                            ? html`
                                  <button
                                      class="button"
                                      disabled=${busy}
                                      onClick=${() => request("dismiss", { tag })}
                                  >
                                      Dismiss this release
                                  </button>
                              `
                            : null
                    }
                </div>
            </section>
            <section class="x-update-notifier-card" aria-label="Check status">
                <div class="x-update-notifier-check" role="status">${checkState}</div>
                ${transportError || state.error ? html`<div class="error-box" role="alert">${transportError || state.error}</div>` : null}
                ${state.stale ? html`<p class="x-update-notifier-warning small">The saved result may be out of date. The last successful result is kept until a check succeeds.</p>` : null}
                <dl class="x-update-notifier-times">
                    <div>
                        <dt>Last success</dt>
                        <dd>${date(state.lastSuccessAt)}</dd>
                    </div>
                    <div>
                        <dt>Last attempt</dt>
                        <dd>${date(state.lastAttemptAt)}</dd>
                    </div>
                    <div>
                        <dt>Automatic check</dt>
                        <dd>
                            ${state.automatic ? (state.nextAutomaticAt > time ? `After ${date(state.nextAutomaticAt)}` : "Due while Pocket is open") : "Off"}
                        </dd>
                    </div>
                </dl>
                ${waiting ? html`<p class="muted small">${state.rateLimitedUntil ? "GitHub wait" : "Next manual check"}: after ${date(state.manualAfter)}.</p>` : null}
                <div class="setting x-update-notifier-setting">
                    <div>
                        <strong>Automatic checks</strong>
                        <p class="muted small">Check while an owner has Pocket open.</p>
                    </div>
                    <${pocket.Switch}
                        label="Automatic update checks"
                        on=${automatic}
                        disabled=${busy}
                        onChange=${() => request("settings", { automatic: !automatic })}
                    />
                </div>
            </section>
            <p class="muted small x-update-notifier-note">
                Checks use GitHub’s public API from this server, without a token. Normally once every six hours; failures wait at least 15 minutes for an automatic retry. This extension never installs updates or restarts Pocket.
            </p>
        </div>`;
    }

    pocket.page({ id: "updates", title: "Pocket updates", component: Updates });
    pocket.menu({ id: "updates", label: "Pocket updates", page: "updates" });
    pocket.launcher({
        id: "updates",
        label: "Pocket updates",
        detail: "Check the latest stable release",
        icon: "download",
        keywords: ["version", "release", "update"],
        page: "updates",
    });
    const off = pocket.on("state", accept);

    void request("state").then(() => {
        if (state?.supported) {
            return request("check-if-due", {});
        }
    });
    const timer = setInterval(
        () => {
            void request(
                state?.supported ? "check-if-due" : "state",
                state?.supported ? {} : undefined,
            );
        },
        5 * 60 * 1000,
    );

    return () => {
        stop.abort();
        clearInterval(timer);
        off();
        listeners.clear();
    };
}
