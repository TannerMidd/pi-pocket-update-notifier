# Pocket updates

An owner-only update notification extension for [Pi Pocket](https://github.com/TannerMidd/pi-pocket).
It compares the running server version with the latest published stable release. It does **not**
install updates, run Git, or restart Pocket.

Version **0.1.0** · Requires **Pi Pocket 0.16.0** or later and extension API **1** · MIT

## Use

Open **Pocket updates** from the rail, Menu, or the launcher. The page shows:

- The running version, latest stable version, and last successful check.
- Whether the running version is current, ahead, or a prerelease.
- Check progress, errors, and a warning when the saved result may be out of date.
- **Check now**, a link to the release, and an **Automatic checks** switch.
- **Dismiss this release**, which turns off that release's badge and notice. The release stays visible.

A **New** badge appears only when a newer stable release is available and is not dismissed. A notice
uses browser storage to remember each release for each owner. With storage and the Web Locks API,
tabs show only one notice for each release. On LAN HTTP or a browser without
Web Locks, notices still work, but cross-tab deduplication is best-effort. If storage is blocked,
an in-memory receipt prevents repeated notices in that loaded tab; a reload or another tab can show
the notice again. Guests and viewers cannot load the page or use its routes.

## Install

Read the runtime files before you turn this extension on. For a manual installation, put these files
in the Pocket data folder's `extensions/` directory, with these paths:

```text
update-notifier.ts
update-notifier/domain.ts
update-notifier/index.js
update-notifier/style.css
```

Then open **Menu → Extensions** and turn on **Update notifier**. Open **Pocket updates** to see the
result. There is no separate package installation on the Pocket server. Pocket supplies the Durable
package and the editor types. On an older server, the extension shows that Pocket needs an update;
it does not use private APIs as a fallback.

Changes to `domain.ts` need a server restart, as with other imported server helpers. Turn the
extension off in **Menu → Extensions** to stop checks. This does not remove saved preferences or the
release cache.

## Checks and network access

Automatic checks start **only while an owner has Pocket open**. There is no server scheduler when
all owner tabs are closed. An owner tab asks whether a check is due at startup and about every five
minutes. Browser timer limits can delay this. By default, the server allows a GitHub check once
every **six hours**. After an error, automatic checks wait at least **15 minutes**. An unfinished
check waits 15 minutes from its saved attempt time.

**Automatic checks** is on by default. When it is off, only **Check now** can start a GitHub request.
A check already in progress can finish. Reading the status never contacts GitHub.

Manual checks wait at least **one minute** after the previous attempt. They do not bypass GitHub's
rate limit. A GitHub `Retry-After` or rate-reset wait is saved and bounded to at most 24 hours from
the request. This also applies when a successful response reports no requests left. A rate-limited
request waits at least 15 minutes. These limits apply across tabs, module reloads, and server
restarts. A disconnect or storage failure can leave a check marked as
unfinished; its saved attempt time still prevents immediate retries.

The server sends one unauthenticated `GET` to this fixed public endpoint:

```text
https://api.github.com/repos/TannerMidd/pi-pocket/releases/latest
```

The request includes an explicit GitHub `Accept` header and the user agent
`pi-pocket-update-notifier/0.1.0`. It sends no credentials, Pocket version, owner data, session data,
or telemetry. GitHub can see the server's public IP address and request time. The extension does not
follow redirects, accepts at most 64 KiB, and times out after about ten seconds.

The response must identify a published, non-draft, non-prerelease release with a strict SemVer tag
(with an optional lowercase `v` prefix). Build metadata does not change version order. The release
link is constructed from the validated tag and the fixed Pocket GitHub repository. Remote release
HTML, text, links, and assets are not displayed or used.

A failed check keeps the previous good release and its success time. A saved result is marked stale
after six hours or after an error. The saved release can still show an update badge: it is not a
claim that a new check succeeded. Automatic settings, dismissal, cache, attempt times, and retry
limits are stored in the module's global Durable document, `x.update-notifier.state`. Browser notice
history uses owner-scoped `x.update-notifier.notified.*` local storage keys. No Pocket data files or
credentials are read directly.

## Development

Use Node 24 or later. For a source checkout, install the development dependencies, then run:

```sh
npm run format
npm run check
npm test
```

`check` checks server TypeScript, browser JavaScript, and browser syntax. The four small tests cover
version and network validation, owner controls and durable rate limits, concurrent request lifetimes
and storage failures, and browser notification cleanup. Tests use an in-memory Durable session and
a fake GitHub response. They do not contact GitHub or a model provider.

The extension uses only public Pocket and Durable APIs. It adds no model tools, hooks, provider
settings, process calls, updater, or install/restart actions.
