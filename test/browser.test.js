import assert from "node:assert/strict";
import { test } from "node:test";
import setup from "../update-notifier/index.js";

test("owner browser notices once per release, dismissal clears the badge, and disposal cancels polling", async (t) => {
    const storage = new Map();
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
            locks: { request: async (_key, _options, run) => run() },
        },
    });
    Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
            getItem: (key) => storage.get(key),
            setItem: (key, value) => storage.set(key, value),
        },
    });
    let tick;
    let cleared = false;
    t.mock.method(globalThis, "setInterval", (run) => {
        tick = run;
        return 123;
    });
    t.mock.method(globalThis, "clearInterval", (id) => {
        assert.equal(id, 123);
        cleared = true;
    });
    const badges = [];
    const notices = [];
    const calls = [];
    let receive;
    let off = false;
    let signal;
    const state = {
        supported: true,
        running: "0.16.0",
        badge: true,
        latest: { tag: "v0.17.0", version: "0.17.0" },
    };
    const pocket = {
        me: () => ({ role: "owner", id: "owner-a" }),
        style() {},
        page() {},
        menu() {},
        launcher() {},
        rail: () => ({ update: (value) => badges.push(value.badge) }),
        notify: (_level, message) => notices.push(message),
        on: (_event, run) => {
            receive = run;
            return () => {
                off = true;
            };
        },
        api: (path, _body, options) => {
            calls.push(path);
            signal = options.signal;
            return path === "state"
                ? Promise.resolve(state)
                : new Promise((_resolve, reject) => {
                      signal.addEventListener("abort", () => reject(new Error("aborted")), {
                          once: true,
                      });
                  });
        },
    };
    let dispose;

    try {
        dispose = setup(pocket);
        await new Promise(setImmediate);
        receive(state);
        receive({ ...state, dismissed: true, badge: false });
        assert.equal(badges.at(-1), null);
        receive(state);
        assert.equal(notices.length, 1);
        assert.ok([...storage.keys()][0].startsWith("x.update-notifier.notified.owner-a."));
        assert.deepEqual(calls, ["state", "check-if-due"]);
        globalThis.navigator.locks = undefined;
        const fallback = { ...state, latest: { tag: "v0.18.0", version: "0.18.0" } };
        receive(fallback);
        receive(fallback);
        assert.equal(notices.length, 2);
        t.mock.method(globalThis.localStorage, "getItem", () => {
            throw new Error("Storage blocked");
        });
        const memoryOnly = { ...state, latest: { tag: "v0.19.0", version: "0.19.0" } };
        receive(memoryOnly);
        receive(memoryOnly);
        assert.equal(notices.length, 3);
        dispose();
        assert.equal(signal.aborted, true);
        assert.equal(cleared, true);
        assert.equal(off, true);
        tick();
        await new Promise(setImmediate);
        assert.equal(calls.length, 2);
        assert.equal(setup({ me: () => ({ role: "guest" }) }), undefined);
    } finally {
        dispose?.();
        if (previous) {
            Object.defineProperty(globalThis, "localStorage", previous);
        } else {
            delete globalThis.localStorage;
        }
        if (previousNavigator) {
            Object.defineProperty(globalThis, "navigator", previousNavigator);
        } else {
            delete globalThis.navigator;
        }
    }
});
