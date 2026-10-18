# IssueMon

A desktop app for macOS and Linux (Electron) that watches Jira issues for you. Paste an issue URL or key; IssueMon checks periodically, notifies you and shows exactly *what* changed, and you tick changes off as *Processed*. It also lists **stale issues** for you and the colleagues you choose, and keeps short **notes** that become an issue with one click.

Tracking is separate from "watching" in Jira. The only thing IssueMon ever writes to Jira is an issue you create from a note.

![IssueMon showing changed issues](docs/screenshot.png)

## Install

**Requirements:** macOS 13 (Ventura) or later, on Apple silicon or Intel, or Linux on x64 with a graphical desktop (X11 or Wayland). A Jira **Cloud** site (`yourcompany.atlassian.net`) and an Atlassian API token. Jira Server and Data Center are not supported.

### Homebrew

```bash
brew install --cask fundament-agency/tap/issuemon
```

This taps and trusts `fundament-agency/homebrew-tap` in one step. The cask removes the quarantine flag from the app, so macOS doesn't block it, also after `brew upgrade --cask issuemon`.

### Download

Download the `.dmg` for your Mac (`arm64` for Apple silicon, `x64` for Intel) from the [Releases page](https://github.com/fundament-agency/issuemon/releases), open it and drag `IssueMon.app` to Applications.

### Linux

Download `issuemon-<version>-linux-x86_64.AppImage` from the [Releases page](https://github.com/fundament-agency/issuemon/releases), make it executable and start it:

```bash
chmod +x issuemon-*-linux-x86_64.AppImage
./issuemon-*-linux-x86_64.AppImage
```

An AppImage needs no installation, and this one no `libfuse2` either. For an entry in your desktop's app menu, use a tool such as Gear Lever or AppImageLauncher. On GNOME, the tray icon only shows with an AppIndicator extension; see *Background* in the table below.

### First launch

On a Mac, IssueMon is not notarized by Apple, so macOS blocks it once per `.dmg` install or upgrade (Homebrew removes the quarantine flag itself). Click *Done*, open **System Settings → Privacy & Security**, scroll to "IssueMon was blocked…", click **Open Anyway** and confirm. Control-click → *Open* no longer works since macOS 15. Or remove the quarantine flag in a terminal:

```bash
xattr -dr com.apple.quarantine /Applications/IssueMon.app
```

### Updates

IssueMon checks once a day for a newer release and tells you in the app; it never downloads or installs anything. Update with Homebrew, a new `.dmg` or, on Linux, a new AppImage. See *Updates* in the table below, also for switching the check off.

## Getting started

On first start the connect screen asks for:

- **Jira URL**, e.g. `https://yourcompany.atlassian.net`
- **Email address** of your Atlassian account
- **API token**, created at [id.atlassian.com → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens)

After *Connect*, IssueMon suggests tracking your first issue: paste a URL or key into the paste field, or anywhere in the window (⌘V, on Linux Ctrl+V). More options are in **Settings**.

## What the app does

| Part | Behaviour |
|---|---|
| **Tracking** | Paste a URL (`/browse/ABC-1`, `?selectedIssue=ABC-1`), a key or several keys at once, or a list mixing them. In a link only the key at the end of the path and `selectedIssue` count: the host name (`acme-sandbox-952.atlassian.net`), other parameters (also `jql`) and the fragment (`#comment-10234`) never give a key. A bare number (`123` or `#123`) gets the *default project*, also among full keys, as long as you paste only keys and numbers. Adding an issue records its current state; only later changes count. |
| **Checking** | Every 10 minutes (5, 10, 15, 30 or 60 configurable), 5 s after the computer wakes up and on demand (⌘R). Moved issues are followed by id. When Jira is unreachable (no connection, a timeout, a server error), retries follow after 30 s, 1 and 2 minutes, then every 5 minutes or at the normal interval if that is shorter, until one succeeds. A `Retry-After` header from Jira makes the next check wait at least that long. When the request for one issue's changes or comments fails for a reason that passes (a server error, no connection, a timeout, an answer IssueMon cannot read, or an issue that has just disappeared, which the next check reports as missing), only that issue waits and is looked up again at the next check, so none of its changes are lost; the other issues, the missing ones and the Stale list are processed as usual, and the check still reports the error, with the same retries. After a rate limit or a login error IssueMon sends no further requests for changes or comments in that check: the issues not reached wait for the next check, and what was found before is still recorded and notified; with a login error, no issue is concluded to be missing either. Any other refusal of the changelog or comments (such as 400, 403 or 410, or a 404 for an issue that still exists, asked once more first in case it was gone for a moment) falls back to comparing the issue's status, assignee, priority, title, labels and fix versions, without author, comments or attachments |
| **Changed** | Status, comments, assignment (to you: highlighted), priority, description (word-level diff), attachments, labels, sprint and more, with author and time. Each edit to a comment is a change of its own, with the new text, marked word by word when IssueMon still has the old text; the chip *N comments edited* counts comments, not edits. New and edited comments that @-mention your Jira account get a *Mentions you* chip and row accent; the actual mention is highlighted in the timeline. Flags follow the connected Jira account, clear while reconnecting, and are recalculated for stored comments when the account becomes known or tracking is restored by Undo; older records without mention account ids stay unflagged. Responses still in flight from a previous account cannot replace the current identity or people list, mark issues missing, or notify. Plain text names, mentions of other accounts and description mentions do not count. Changed stays sorted by time. Only an issue's latest 100 comments are checked, so an edit to an older one goes unnoticed. Backlog order (*Rank*) and time tracking are ignored. A tracked issue that was deleted, or that you can no longer see, counts once as a change, *No longer accessible (deleted, or you no longer have access)*, with a notification; only an issue Jira leaves out of a real answer counts, never no connection, a timeout, a server error or a temporary error on that issue, and the first check after connecting or changing the account stays quiet. If the issue comes back, its error clears without a notification, and that change, if still open, is marked processed. A date in a description or comment shows as `YYYY-MM-DD`, or as written when it is no millisecond timestamp. The detail shows labels and fix versions when set, the parent key and summary, sub-tasks with a done count, linked issues with their relationship and status, and the description (long texts collapsed). Without new changes, it also shows the latest comment and change. Clicking a related key selects it if tracked, or offers *Track*. |
| **Tracked** | Finished issues (status category *Done*, such as Done or Closed) without open changes are grouped under *Done* at the bottom, collapsed by default. *Stop tracking* per issue and *Stop all* for the group, both undoable; nothing stops automatically, so an issue that was deleted or that you can no longer see keeps its red row (*Not found, or no longer accessible*), also after *Processed*, until you stop tracking it. Above five tracked issues, a filter on key, title, assignee or status appears. |
| **Processed** | Ticks off an issue's open changes (button or **E**); *Mark all processed* in Changed does it for every changed issue. Undoable. In Changed, the selection moves to the next changed issue. |
| **Own changes** | Not notified by default: stored as processed and marked *own change, not notified* in the timeline. Turn off *Don't notify my own changes* to test notifications with your own edits. |
| **Notifications** | One per changed issue, also when the check that found it ended with an error for another issue, leading with the most important fresh pending change: assignment to you, then a mention of you, then an explicitly flagged risk change, then other changes; newest first within each kind. More than 3 changed issues give a single summary, counting issues assigned to you, mentioning you or with flagged risk changes, with those keys first in that order. An issue counts once per applicable kind. Changed keeps its time order. When the leading change is a comment mentioning you, its notification says who mentioned you and on which issue. Clicking one opens that issue's changes, on macOS also after a restart. *Send test notification* in Settings shows whether the system displays notifications, or why not. macOS only shows notifications from a signed app: there the development version (`npm start`) shows none, the built app does. On Linux both do, through the desktop's notification service. |
| **Stale** | Query: `assignee = currentUser() AND statusCategory != Done AND updated <= -14d ORDER BY updated ASC`, so by default only your issues, and finished ones never count. Tick colleagues under *People* in Settings for `assignee IN (…)` with their account ids, and *Unassigned* for `(… OR assignee IS EMPTY)`; the list holds all active people on the site, without apps, customers and deactivated accounts. The Stale page filters on one or more of them, *Unassigned* included (nothing chosen = everyone), and remembers the filter; the filter menu shows next to each of them, and next to *Everyone*, how many stale issues they have, whatever the filter; the count next to *Stale* in the sidebar is that of the filtered list. Configurable: days (1–365); excluded statuses such as Backlog or On hold (none by default; adds `AND status NOT IN (…)`; a status unknown to your Jira is skipped with a warning, whatever characters its name holds, and a failed request leaves no old warning behind); excluded projects in one comma-separated field, by name or key, `*` matching any text (none by default; `ARCHIVE-*` skips every project whose name or key starts with ARCHIVE-). Sorted *Oldest first* by last update; the button next to the filter switches to *Newest first* and is remembered. Up to 1000 results. The detail shows the latest comment and change; *Track too* starts tracking the issue. |
| **Notes** | One-liners of at most 255 characters (long ones wrap). Add (Enter), edit (click the text; Enter saves, Esc reverts), tick off (struck through, not counted, cannot become an issue; reversible) and delete (undoable). New notes go on top; reorder by dragging the grip on the left or with `⌥↑`/`⌥↓` in the text. *Create issue* on any unticked note opens a panel below it to adjust the title, project (the notes project, else the default project; free text) and type (*Task*, or its Dutch, French, German or Spanish name *Taak*, *Tâche*, *Aufgabe* or *Tarea*; else the first plain type; never an epic or sub-task), and to choose an assignee and add a description. The assignee is *Unassigned* by default and is picked from the people list that Stale uses (`users/search`): *Unassigned*, you, then everyone by name, in a menu like the Stale filter (Enter or a click opens it, `↑`/`↓` move, Enter picks, Esc closes only the menu), with a search field above eight people where Enter picks the first match. The description is optional and a few lines long; every non-empty line becomes a paragraph, and Enter starts a new line. Without any project the panel says so in a neutral hint, which turns red only after *Create*; nothing is sent then. Nothing reaches Jira until *Create* or Enter; *Cancel* or Esc closes the panel. The issue lands in the backlog, the note disappears and the issue is tracked right away. |
| **Settings** | Account (Jira URL, email address, API token, *Test connection*); checking (interval, default project, start at login); notifications (on/off, *Don't notify my own changes*, *Send test notification*); appearance (theme, language); stale issues (people, unassigned, days, excluded statuses, excluded projects); notes (project for new issues, else the default project); about (version, *Check for updates once a day*, *Check now*). Every change is saved immediately. A Jira URL on another host clears the stored API token and swaps in that site's own *Tracked* list: every Jira site (host, with its port) keeps its list, empty for a site you never used, and switching back restores the old list with its changes and what you had seen. Issue ids are only unique within one site, so a tracked issue is never matched to, renamed after or notified for an issue of another site. A change of email address, or of the path, scheme, case or trailing slash of the same host, keeps the list. Coming back to a site, the first check reports what changed since you left, recorded and notified like any other change. Notes are not tied to a site. The Stale list is fetched from the current site and not kept per site: it is emptied on a switch and filled by the next check. The Stale settings, people chosen on another site included, carry over unchanged. A refused address (plain http to a non-local host) is not saved; the stored URL and token stay. |
| **Appearance** | Theme *System*, *Light* or *Dark*, in Settings → Appearance or the menu View → Theme; *System* follows the system's light or dark mode. A warm, soft palette: stone tints in light, warm anthracite in dark. |
| **Language** | English, Dutch, French, German and Spanish. *System* (the default) follows the system language and falls back to English. Change it in Settings → Appearance or the menu View → Language; it is stored with the settings and applies at once to the window, all menus (the standard Edit, View and Window items too), the menu bar icon and new notifications. Error messages and warnings from the last check follow within a second, or at the next attempt while IssueMon waits after a failed check. |
| **Background** | Closing the window keeps IssueMon checking in the menu bar. The number of changed issues shows in the menu bar and on the Dock icon; the menu bar icon's menu lists up to 10 changed issues, click one to open it. Optionally the app starts at login, in the background (built app only). On Linux a tray icon takes the menu bar icon's place where the desktop shows one (GNOME needs an AppIndicator extension), with the count in its tooltip, and clicking it opens the window; without a tray, start IssueMon again to bring the window back. The Dock badge is macOS only. Start at login writes `~/.config/autostart/issuemon.desktop` (or under `$XDG_CONFIG_HOME`), which starts the AppImage hidden; after moving the AppImage, start it once so the entry follows. Switching IssueMon off in the desktop's own autostart settings sticks. |
| **Updates** | Once a day (first a minute after launch, and after waking when a day has passed) IssueMon asks GitHub for the latest release. If it is newer, a toast says *IssueMon 0.2.0 is available*, with *View release* (opens the release page in your browser) and *Later* (hides that version until a still newer one appears). Nothing is downloaded or installed: update with `brew upgrade --cask issuemon` or from the [Releases page](https://github.com/fundament-agency/issuemon/releases); on Linux, download the new AppImage there. Settings → About shows the Homebrew command only on macOS. *Check for Updates…* in the app menu (after *About*; macOS only) and *Check now* in Settings → About check at once and answer with a toast: *You're up to date*, the update, or *Could not check for updates* (no connection, GitHub's rate limit; never a dialog). *Check for updates once a day* in Settings → About switches the daily check off. The development version never checks on its own; *Check now* always works. |

Shortcuts: `j`/`k` or `↑`/`↓` to browse, `e` for processed, `o` to open in Jira, `u` to stop tracking, `/` or `⌘K` to paste, `⌘L` to track an issue (via the menu), `⌘R` to check now, `⌘1`–`⌘4` for Changed, Tracked, Stale and Notes, `⌘,` for Settings, `⌘Z` to undo the last action (while its toast is visible), `Esc` to go back or close, `⌥↑`/`⌥↓` in a note to move it, and `?` for this overview in the app. On Linux, ⌘ is Ctrl and ⌥ is Alt, in the app's labels too.

## Storage and privacy

- All data, the API token included, lives in `~/.issuemon/issuemon.json`, readable only by you (file mode 0600, folder 0700; wider permissions on an existing folder or file are tightened). The token never reaches the renderer, but any program running under your account can read the file. Only Electron's own files, such as caches, live in `~/Library/Application Support/IssueMon` (Linux: `~/.config/IssueMon`).
- The token is only sent to the site it was entered for; changing the Jira URL to another host clears it.
- The tracked issues are kept per Jira site: `tracked` in the data file is the list of the site in `site` (its host), and `sites` holds the lists of the sites you left, as `{ host, tracked }`. Changing the URL to another host moves the list over; `site` is always derived from the configured URL when the file is read, and storage from before belonged to the host that was configured. Lists of other sites carry no mention flags, since those follow the connected account.
- Nothing is stored in the macOS keychain, and Chromium's *IssueMon Safe Storage* key is not used (`use-mock-keychain`), so macOS never shows a keychain prompt for IssueMon. On Linux GNOME Keyring and KWallet are not used either (`password-store=basic`), so they never ask to be unlocked.
- The User-Agent is always `IssueMon/<version>`: Jira Cloud rejects `POST` requests with a browser User-Agent (`403 XSRF check failed`).
- Network traffic goes only to your own Jira site over https (plain http is refused, except for `localhost`, `127.0.0.1` and `[::1]` for testing), via these Jira Cloud REST API v3 endpoints, plus the update check:
  - `issue` (create, only via *Create issue*)
  - `issue/createmeta/{project}/issuetypes`
  - `issue/bulkfetch`
  - `issue/{key}/changelog`
  - `issue/{key}/comment`
  - `search/jql`
  - `myself`
  - `users/search` (the list of people for Stale and for the assignee of a new issue, at most once an hour)
- The update check asks `https://api.github.com/repos/fundament-agency/issuemon/releases/latest` once a day, sending only the User-Agent `IssueMon/<version>` and nothing about you or your Jira (GitHub sees your IP address, as with any request). Nothing is downloaded. *Check for updates once a day* in Settings → About switches it off.

## Development

### Running from source

```bash
npm install
npm start
```

Use the Node version in `.nvmrc`. The development version shows no notifications and never checks for updates on its own.

### Mock Jira

To try the app without a real Jira:

```bash
npm run mock-jira
```

Connect with URL `http://localhost:4778`, email `demo@example.com`, token `demo`. Trigger changes at <http://localhost:4778/__mock>, then *Check now* (⌘R) in IssueMon. `PORT=<port> npm run mock-jira` uses another port.

### Tests

```bash
npm test            # unit and integration tests, against the mock Jira
npm run test:e2e    # drives the real app via Playwright through all flows; screenshots in e2e/screenshots/
ISSUEMON_APP=dist/mac-arm64/IssueMon.app/Contents/MacOS/IssueMon npm run test:e2e   # same, against the built app (npm run pack)
xvfb-run -a npm run test:e2e   # on Linux: in a virtual display (package xvfb); add ISSUEMON_APP=dist/issuemon-<version>-linux-x86_64.AppImage for the AppImage
npm run icons       # regenerate the icons from SVG (scripts/make-icons.js)
npm run fuzz        # property-based fuzzer: random, seeded inputs; see below
```

`npm run fuzz` checks rules that must hold for every input, not just the examples in the tests: from `parseKeys`, the word diff and the ADF text up to the window's HTML (for escaping) and the tracker against the mock Jira, with transient network failures, Jira changing during a check, overlapping actions and a switch between two sites. A failure shows the broken rule, the input shrunk to a small case and a `--replay` command. `--seed`, `--runs`, `--only`, `--all` and `--list` are explained by `npm run fuzz -- --help`. It is not part of `npm test`, because it reports open bugs until they are fixed.

On GitHub, the e2e tests run on macOS and on Linux (Ubuntu, under `xvfb-run`), both from source and against the built Apple silicon app and AppImage, which keeps fewer languages and has no SwiftShader (see *Building an app*); the release workflow tests the app it uploads.

`test/i18n.test.js` checks that every catalog in `src/shared/locales/` has exactly the keys of `en.js`, with the same plural forms and placeholders, and is translated. UI text lives only in those catalogs.

### Project layout

```
src/
  main/      main.js (window, menu bar, notifications, IPC) · tracker.js (tracking and change detection)
             jira.js (REST client) · changes.js (Jira → changes, pure functions) · store.js (JSON storage)
             paths.js (where the data file lives) · secrets.js (API token in the data file)
             ipc.js (table channel → Tracker method, with the argument coercions)
             updates.js (the daily check for a newer release on GitHub; notify only)
  preload/   preload.js: the only bridge to the page (window.issuemon)
  renderer/  index.html, app.js, base.css, app.css: the interface ("Inbox" layout) · actions.js: optimistic updates and
             Undo, without DOM · reveal.js: completes a row's smooth scroll across renders
  shared/    keys.js: recognising issue keys · diff.js: word-level diff · text.js: shortening text between grapheme clusters, and initials · inbox.js: the Changed, Tracked/Done and Stale lists,
             counts and selection · change.js: a change in words (labels, "assigned to you", notification and chip text) ·
             rules.js: note and project rules, intervals, themes, connected check, default issue type ·
             i18n.js: languages, the system-language fallback and the translator t(key, params) with plurals ·
             locales/: one message catalog per language (en.js is the source, nl.js …); all shared by main and renderer
  assets/    app and menu bar icons (generated by npm run icons)
scripts/     make-icons.js: renders the icons in build/ and src/assets/ from SVG · after-pack.js: trims the built app before signing
             artifact-build-completed.js: the .tar.xz next to each .dmg, and LZMA for the .dmg · verify-archives.sh: checks both
test/        node:test tests + support/mock-jira.js
e2e/         Playwright tests of the real Electron app
fuzz/        run.js: the fuzzer · lib/: seeded inputs, shrinking, the tracker against the mock Jira, the renderer in a vm · targets/: the properties
```

### Environment variables

For tests:

- `ISSUEMON_HOME`: another data folder (default `~/.issuemon`)
- `ISSUEMON_USER_DATA`: another folder for Electron's own files; without `ISSUEMON_HOME` the data file lives there too
- `ISSUEMON_TOKEN`: token from the environment, not stored
- `ISSUEMON_E2E=1`: notifications and external links are recorded instead of shown or opened, the daily update check does not run, and the window may exceed the screen so small displays get the desktop layout
- `ISSUEMON_UPDATE_URL`: another address for the update check's "latest release" request (default `https://api.github.com/repos/fundament-agency/issuemon/releases/latest`); the mock Jira answers at `/__releases/latest` with the running version unless a test sets `jira.release`
- `ISSUEMON_APP`: path to the executable of a built app for `npm run test:e2e`

### Building an app

```bash
npm run dist
```

On a Mac this produces four assets in `dist/`:

- `issuemon-<version>-arm64.dmg` and `issuemon-<version>-arm64.tar.xz` (Apple silicon)
- `issuemon-<version>-x64.dmg` and `issuemon-<version>-x64.tar.xz` (Intel)

The `.tar.xz` holds the same app as the `.dmg` and is what Homebrew installs. `scripts/artifact-build-completed.js` writes it and compresses the `.dmg` with LZMA (macOS 10.15 and later); `scripts/verify-archives.sh arm64 x64` checks both the way the release workflow does.

Open a `.dmg` and drag `IssueMon.app` to Applications. `npm run pack` builds without an installer, to `dist/mac-arm64/IssueMon.app` (Intel: `dist/mac/IssueMon.app`).

On Linux it produces `issuemon-<version>-linux-x86_64.AppImage`, with `npm run pack` building just `dist/linux-unpacked/`. The AppImage uses the static AppImage runtime (`toolsets.appimage` in `package.json`), so it starts without `libfuse2`, which current Debian and Ubuntu no longer install. The macOS assets can only be built on a Mac.

The app keeps Chromium's resources only for its own five languages, plus British English and Latin American Spanish, which macOS picks for regional variants such as en-AU or es-MX (`electronLanguages` in `package.json`, with Chromium's own names for Linux under `linux`). On a Mac in another language IssueMon falls back to English with en-GB dates; Chromium's few own texts, such as form-validation messages, then come in English or in a later macOS language that it has. `scripts/after-pack.js` also removes SwiftShader, the software Vulkan that Chromium only uses for WebGL without a GPU; IssueMon draws no WebGL, and without a GPU the window is drawn in software.

Electron downloads its own files on first use; `npm run pack` and `npm run dist` fetch them first (`install-electron`), because the build copies Electron's licence notices from them and stops if one is missing.

The app is *ad-hoc* signed and not notarized. Built locally, it just starts; on another Mac, macOS blocks it the first time, see *First launch*.

## Contributing and security

Contributions are welcome: read [CONTRIBUTING.md](CONTRIBUTING.md) first. To report a vulnerability, follow [SECURITY.md](SECURITY.md) and do not open a public issue.

## License

MIT, see [LICENSE](LICENSE). Copyright © 2026 Fundament.
