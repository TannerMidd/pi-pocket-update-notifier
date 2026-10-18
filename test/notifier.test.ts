import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { createSession, MemoryStorage } from "@earendil-works/pi-durable";
import type { Host, Web, WebHandler, WebRequest } from "../_pocket.d.ts";
import setup from "../update-notifier.ts";
import {
    API_URL,
    CADENCE,
    COOLDOWN,
    compareVersions,
    fetchLatest,
    parseVersion,
    validateRelease,
} from "../update-notifier/domain.ts";

const release = (tag = "v0.17.0") => ({
    id: 42,
    tag_name: tag,
    draft: false,
    prerelease: false,
    published_at: "2026-10-18T12:00:00Z",
    html_url: "https://untrusted.invalid/",
    body: "<script>ignored</script>",
});
const version = (text: string) => parseVersion(text)!;

async function fixture() {
    const session = createSession(new MemoryStorage());
    const routes = new Map<string, WebHandler>();
    let time = 1_000_000;
    let calls = 0;
    let failWrite = false;
    let fetcher: typeof fetch = async () => Response.json(release());
    let dispose = () => {};
    const host = { pocketVersion: "0.16.0-rc.1+local" } as Host;
    const web: Pick<Web, "route" | "client" | "onDispose" | "send" | "error"> = {
        route(method, path, handler, options) {
            assert.equal(options?.access, "owner");
            routes.set(`${method} ${path}`, handler);
        },
        client(entry, options) {
            assert.equal(entry, "update-notifier");
            assert.equal(options?.access, "owner");
        },
        onDispose(run) {
            dispose = run;
        },
        send(_name, _data, options) {
            assert.equal(options?.to, "owner");
        },
        error: (status, message) => Object.assign(new Error(message), { status }),
    };
    const reload = () =>
        setup(host, web as Web, {
            now: () => time,
            fetcher: async (...args) => {
                calls++;
                return fetcher(...args);
            },
        });
    reload();

    const call = async (route: string, body = {}, extra: Partial<WebRequest> = {}) => {
        const lifetime = withCancel(BACKGROUND_CONTEXT);
        const request: WebRequest = {
            user: { id: "owner", name: "Owner", role: "owner" },
            body,
            method: "GET",
            params: {},
            query: new URLSearchParams(),
            signal: lifetime.context.abortSignal!,
            context: lifetime.context,
            snapshot: session.snapshot.bind(session),
            commit: (change) => {
                if (failWrite) {
                    failWrite = false;
                    return Promise.reject(new Error("Injected storage failure"));
                }
                return session.commit(change, lifetime.context);
            },
            ...extra,
        };

        try {
            return (await routes.get(route)!(request)) as any;
        } finally {
            lifetime.cancel();
        }
    };

    return {
        call,
        reload,
        dispose: () => dispose(),
        close: () => session.close(BACKGROUND_CONTEXT),
        advance: (ms: number) => {
            time += ms;
        },
        fetcher: (value: typeof fetch) => {
            fetcher = value;
        },
        failWrite: () => {
            failWrite = true;
        },
        get calls() {
            return calls;
        },
        get time() {
            return time;
        },
    };
}

test("strict SemVer and stable metadata; fixed, bounded, timed network reads", async () => {
    assert.equal(compareVersions(version("1.2.3-beta.2+local"), version("1.2.3-beta.10")), -1);
    assert.equal(compareVersions(version("1.2.3-beta.10"), version("1.2.3")), -1);
    assert.equal(compareVersions(version("1.2.3+local"), version("1.2.3+remote")), 0);
    assert.equal(compareVersions(version("1.3.0-alpha"), version("1.2.3")), 1);
    assert.equal(parseVersion("1.2.3-01"), null);
    assert.equal(parseVersion("01.2.3"), null);
    assert.equal(parseVersion("1.2.3\n"), null);
    assert.throws(() => validateRelease(release("v1.2.3/path")));
    assert.throws(() => validateRelease(release("v1.2.3-beta")));
    assert.throws(() => validateRelease({ ...release(), draft: true }));
    const signal = new AbortController().signal;
    const { release: latest, retryUntil } = await fetchLatest(
        signal,
        async (url, options) => {
            assert.equal(url, API_URL);
            assert.equal(options?.redirect, "error");
            assert.ok(options?.signal);
            assert.deepEqual(options?.headers, {
                Accept: "application/vnd.github+json",
                "User-Agent": "pi-pocket-update-notifier/0.1.0",
            });
            return Response.json(release(), {
                headers: {
                    "x-ratelimit-remaining": "0",
                    "x-ratelimit-reset":
                        "99999999999999999999999999999999999999999999999999999999999",
                },
            });
        },
        () => 0,
    );
    assert.equal(retryUntil, 24 * 60 * 60 * 1000);
    assert.equal(latest.url, "https://github.com/TannerMidd/pi-pocket/releases/tag/v0.17.0");
    assert.equal("body" in latest, false);
    await assert.rejects(
        fetchLatest(
            signal,
            async () =>
                new Response(
                    new ReadableStream({
                        start(controller) {
                            controller.enqueue(new Uint8Array(65537));
                            controller.close();
                        },
                    }),
                ),
        ),
    );
    await assert.rejects(
        fetchLatest(
            signal,
            (_url, options) =>
                new Promise((_resolve, reject) => {
                    options!.signal!.addEventListener("abort", () => reject(new Error("aborted")), {
                        once: true,
                    });
                }),
            () => 0,
            5,
        ),
    );
});

test("owner controls, durable cache and dismissal, cadence, error preservation and rate limits", async () => {
    const f = await fixture();

    try {
        await assert.rejects(
            f.call("GET state", {}, { user: { id: "guest", name: "Guest", role: "guest" } }),
            { status: 404 },
        );
        assert.equal((await f.call("GET state")).checkState, "never");
        assert.equal(f.calls, 0);
        const first = await f.call("POST check-if-due");
        assert.equal(first.badge, true);
        assert.equal(first.prerelease, true);
        await f.call("GET state");
        await f.call("POST check");
        assert.equal(f.calls, 1);
        await f.call("POST dismiss", { tag: first.latest.tag });
        await f.call("POST settings", { automatic: false });
        f.reload();
        f.advance(CADENCE);
        let state = await f.call("POST check-if-due");
        assert.equal(f.calls, 1);
        assert.equal(state.dismissed, true);
        assert.equal(state.badge, false);
        assert.deepEqual(state.latest, first.latest);
        assert.equal(state.stale, true);
        f.fetcher(async () => {
            f.advance(10_000); // Retry-After starts when response headers arrive, not when fetching starts.
            return new Response(null, { status: 429, headers: { "Retry-After": "1200" } });
        });
        state = await f.call("POST check"); // Manual checks still work when automatic checks are off.
        assert.equal(state.checkState, "error");
        assert.equal(state.lastSuccessAt, first.lastSuccessAt);
        assert.deepEqual(state.latest, first.latest);
        assert.equal(state.manualAfter, f.time + 20 * 60 * 1000);
        await f.call("POST settings", { automatic: true });
        f.reload();
        f.advance(COOLDOWN);
        await f.call("POST check");
        await f.call("POST check-if-due");
        assert.equal(f.calls, 2); // Neither restart nor manual checks bypass GitHub's wait.
        f.advance(20 * 60 * 1000);
        f.fetcher(async () => Response.json(release("v0.18.0")));
        state = await f.call("POST check-if-due");
        assert.equal(state.badge, true);
        assert.equal(state.error, null);
        assert.equal(state.stale, false);
        assert.equal(state.nextAutomaticAt, f.time + CADENCE);
    } finally {
        await f.close();
    }
});

test("separate request lifetimes deduplicate; disposal and storage failures keep the durable attempt", async () => {
    const f = await fixture();

    try {
        const first = await f.call("POST check");
        f.advance(COOLDOWN);
        let entered!: () => void;
        const fetching = new Promise<void>((resolve) => {
            entered = resolve;
        });
        let fetchSignal!: AbortSignal;
        f.fetcher(
            (_url, options) =>
                new Promise((_resolve, reject) => {
                    fetchSignal = options!.signal!;
                    fetchSignal.addEventListener("abort", () => reject(new Error("aborted")), {
                        once: true,
                    });
                    entered();
                }),
        );
        const pending = f.call("POST check");
        await fetching;
        assert.equal((await f.call("POST check")).checking, true);
        assert.equal(fetchSignal.aborted, false); // The second handler's return must not cancel the first.
        assert.equal(f.calls, 2);
        f.dispose();
        await assert.rejects(pending);
        assert.equal(fetchSignal.aborted, true);
        f.reload();
        assert.equal((await f.call("POST check-if-due")).checkState, "interrupted");
        assert.equal(f.calls, 2);
        f.advance(COOLDOWN);
        f.failWrite();
        await assert.rejects(f.call("POST check"));
        assert.equal(f.calls, 2); // No network call before the attempt is durable.
        f.fetcher(async () => {
            f.failWrite();
            return Response.json(release("v0.18.0"));
        });
        await assert.rejects(f.call("POST check"));
        f.reload();
        const kept = await f.call("POST check");
        assert.equal(f.calls, 3);
        assert.deepEqual(kept.latest, first.latest);
        assert.equal(kept.lastSuccessAt, first.lastSuccessAt);
        assert.equal(kept.checkState, "interrupted");
        const old = await f.call("GET state", {}, { snapshot: undefined });
        assert.equal(old.supported, false);
        await assert.rejects(f.call("POST check", {}, { commit: undefined }), { status: 409 });
    } finally {
        await f.close();
    }
});
