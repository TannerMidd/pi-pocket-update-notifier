import { defineDoc } from "@earendil-works/pi-durable";

export const HOUR = 60 * 60 * 1000;
export const CADENCE = 6 * HOUR;
export const BACKOFF = 15 * 60 * 1000;
export const COOLDOWN = 60 * 1000;
export const API_URL = "https://api.github.com/repos/TannerMidd/pi-pocket/releases/latest";
const RELEASE_URL = "https://github.com/TannerMidd/pi-pocket/releases/tag/";

export type Release = { tag: string; version: string; url: string; publishedAt: string };
export type CheckResult = { release: Release; retryUntil: number };
export type Status =
    | { supported: false; running: string | null; error: string }
    | {
          supported: true;
          running: string;
          latest: Release | null;
          comparison: "unknown" | "update" | "ahead" | "current";
          prerelease: boolean;
          automatic: boolean;
          dismissed: boolean;
          badge: boolean;
          lastAttemptAt: number | null;
          lastSuccessAt: number | null;
          nextAutomaticAt: number | null;
          manualAfter: number;
          rateLimitedUntil: number | null;
          checking: boolean;
          checkState: "checking" | "error" | "interrupted" | "checked" | "never";
          stale: boolean;
          error: string | null;
      };
export type StoredState = {
    automatic: boolean;
    dismissedTag: string | null;
    latest: Release | null;
    lastAttemptAt: number | null;
    lastSuccessAt: number | null;
    nextAutomaticAt: number;
    rateLimitedUntil: number;
    error: string | null;
};

// This kind and its session-wide scope are a permanent stored-data contract.
export const State = defineDoc<StoredState>({
    kind: "x.update-notifier.state",
    version: 1,
    scope: "session",
    initial: initialState,
});

export function initialState(): StoredState {
    return {
        automatic: true,
        dismissedTag: null,
        latest: null,
        lastAttemptAt: null,
        lastSuccessAt: null,
        nextAutomaticAt: 0,
        rateLimitedUntil: 0,
        error: null,
    };
}

type Version = { core: string[]; pre: string[]; version: string };

export function parseVersion(value: unknown): Version | null {
    if (typeof value !== "string" || value.length > 160) {
        return null;
    }

    const match =
        /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
            value,
        );
    const pre = match?.[4]?.split(".") ?? [];

    if (
        !match ||
        match[0] !== value ||
        pre.some((part) => /^\d+$/.test(part) && part.length > 1 && part[0] === "0")
    ) {
        return null;
    }

    return { core: match.slice(1, 4), pre, version: value };
}

function numeric(a: string, b: string): number {
    return a.length === b.length ? (a > b ? 1 : a < b ? -1 : 0) : Math.sign(a.length - b.length);
}

export function compareVersions(a: Version, b: Version): number {
    for (let i = 0; i < 3; i++) {
        const order = numeric(a.core[i], b.core[i]);

        if (order) {
            return order;
        }
    }

    if (!a.pre.length || !b.pre.length) {
        return a.pre.length ? -1 : b.pre.length ? 1 : 0;
    }

    for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
        const left = a.pre[i];
        const right = b.pre[i];

        if (left === undefined || right === undefined) {
            return left === undefined ? -1 : 1;
        }
        if (left === right) {
            continue;
        }

        const ln = /^\d+$/.test(left);
        const rn = /^\d+$/.test(right);

        return ln && rn ? numeric(left, right) : ln !== rn ? (ln ? -1 : 1) : left > right ? 1 : -1;
    }

    return 0;
}

export function validateRelease(value: unknown): Release {
    const item = value as Record<string, unknown> | null;
    const tag = item?.tag_name;
    const version = typeof tag === "string" ? parseVersion(tag.replace(/^v/, "")) : null;

    if (
        !item ||
        Array.isArray(item) ||
        !Number.isSafeInteger(item.id) ||
        (item.id as number) < 1 ||
        item.draft !== false ||
        item.prerelease !== false ||
        !version ||
        version.pre.length ||
        typeof item.published_at !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(item.published_at) ||
        !Number.isFinite(Date.parse(item.published_at))
    ) {
        throw new CheckFailure("GitHub did not return a valid stable release.");
    }

    return {
        tag: tag as string,
        version: version.version,
        url: RELEASE_URL + encodeURIComponent(tag as string),
        publishedAt: item.published_at,
    };
}

export class CheckFailure extends Error {
    retryUntil: number;

    constructor(message: string, retryUntil = 0) {
        super(message);
        this.retryUntil = retryUntil;
    }
}

function retryUntil(response: Response, now: number): number {
    const retry = response.headers.get("retry-after");
    const reset = response.headers.get("x-ratelimit-reset");
    const limited =
        response.status === 403 ||
        response.status === 429 ||
        response.headers.get("x-ratelimit-remaining") === "0";
    const values = [now + BACKOFF];

    if (retry) {
        values.push(
            /^\d+$/.test(retry) ? now + Math.min(Number(retry), 86400) * 1000 : Date.parse(retry),
        );
    }
    if (limited && reset && /^\d+$/.test(reset)) {
        values.push(Math.min(Number(reset) * 1000, now + 24 * HOUR));
    }

    return limited || retry
        ? Math.min(now + 24 * HOUR, Math.max(...values.filter(Number.isFinite)))
        : 0;
}

export async function fetchLatest(
    signal: AbortSignal,
    fetcher: typeof fetch = fetch,
    now: () => number = Date.now,
    timeoutMs = 10_000,
): Promise<CheckResult> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const combined = AbortSignal.any([signal, timeout.signal]);
    let response: Response | undefined;
    let wait = 0;

    try {
        response = await fetcher(API_URL, {
            method: "GET",
            headers: {
                Accept: "application/vnd.github+json",
                "User-Agent": "pi-pocket-update-notifier/0.1.0",
            },
            redirect: "error",
            signal: combined,
        });

        wait = retryUntil(response, now());
        if (!response.ok) {
            throw new CheckFailure(
                wait
                    ? "GitHub limited update checks. Try again after the wait shown below."
                    : `GitHub returned HTTP ${response.status}.`,
                wait,
            );
        }
        if (Number(response.headers.get("content-length")) > 65536 || !response.body) {
            throw new CheckFailure("GitHub returned an empty or oversized release response.");
        }

        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;

        try {
            for (;;) {
                const { done, value } = await reader.read();

                if (done) {
                    break;
                }

                size += value.byteLength;
                if (size > 65536) {
                    throw new CheckFailure("GitHub returned an oversized release response.");
                }

                chunks.push(value);
            }
        } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
        }

        const bytes = new Uint8Array(size);
        let offset = 0;

        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }

        try {
            return {
                release: validateRelease(
                    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
                ),
                retryUntil: wait,
            };
        } catch (error) {
            if (error instanceof CheckFailure) {
                throw error;
            }

            throw new CheckFailure("GitHub returned invalid release data.");
        }
    } catch (error) {
        if (signal.aborted) {
            throw error;
        }
        if (timeout.signal.aborted) {
            throw new CheckFailure("The update check timed out after 10 seconds.", wait);
        }
        if (error instanceof CheckFailure) {
            error.retryUntil = Math.max(error.retryUntil, wait);
            throw error;
        }

        throw new CheckFailure("Could not reach GitHub. The previous result is kept.", wait);
    } finally {
        clearTimeout(timer);
        await response?.body?.cancel().catch(() => {});
    }
}
