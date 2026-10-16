# IssueMon

Desktop app (Electron) that keeps an eye on Jira issues. Paste an issue URL or key; IssueMon checks periodically, notifies you of changes and shows exactly *what* changed. You tick changes off as *Processed*. It also lists **stale issues** for you and the colleagues you choose, and keeps short **notes** that become an issue with one click.

It is a tracking system of its own, separate from "watching" in Jira. The only thing IssueMon ever does in Jira is create an issue when you ask for it from a note.

![IssueMon showing changed issues](docs/screenshot.png)

## Install

**Requirements:** macOS 13 (Ventura) or later, on Apple silicon or Intel. A Jira **Cloud** site (`yourcompany.atlassian.net`) and an Atlassian API token. Jira Server and Data Center are not supported.

### Homebrew

```bash
brew install --cask fundament-agency/tap/issuemon
```

This taps `fundament-agency/homebrew-tap` and installs the cask in one step, so it also trusts that tap. Update with `brew upgrade --cask issuemon`.

### Download

Download the `.dmg` for your Mac from the [Releases page](https://github.com/fundament-agency/issuemon/releases): `arm64` for Apple silicon, `x64` for Intel. Open it and drag `IssueMon.app` to Applications.

### First launch

IssueMon is not notarized by Apple, so macOS blocks it once per install or upgrade, whichever way you installed it. Click *Done* on the dialog, open **System Settings → Privacy & Security**, scroll to "IssueMon was blocked…" and click **Open Anyway**, then confirm (Control-click → *Open* no longer works since macOS 15). Alternatively, in a terminal:

```bash
xattr -dr com.apple.quarantine /Applications/IssueMon.app
```

### Updates

IssueMon checks once a day for a newer release and tells you in the app; it never downloads or installs anything itself. Update with Homebrew or download the new `.dmg`. Details, including how to switch the check off, are under *Updates* in the table below.

## Getting started

On first start IssueMon shows a connect screen. Fill in:

- **Jira URL**, e.g. `https://yourcompany.atlassian.net`
- **Email address** of your Atlassian account
- **API token**, created at [id.atlassian.com → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens)

After *Connect*, IssueMon suggests tracking your first issue: paste an issue URL or key into the paste field, or anywhere in the window (⌘V). More options are in **Settings**.

## What the app does

| Part | Behaviour |
|---|---|
| **Tracking** | Paste a URL (`/browse/ABC-1`, `?selectedIssue=ABC-1`), a key, or several keys at once. A bare number (`123` or `#123`) is completed with the *default project*, also next to full keys, as long as you paste only keys and numbers. Adding an issue records its current state; only later changes count. |
| **Checking** | Every 10 minutes by default (5, 10, 15, 30 or 60 configurable), 5 s after the Mac wakes up, and on demand (⌘R). Moved issues are followed by id. When Jira is unreachable (no connection, a timeout or a server error), checks retry after 30 s, 1 and 2 minutes, then every 5 minutes (or at the normal interval if that is shorter) until one succeeds. A `Retry-After` header from Jira makes the next check wait at least that long. |
| **Changed** | Status transitions, comments, assignment, priority, description (difference highlighted per word), attachments, labels, sprint and so on, with author and time. Backlog order (*Rank*) and time tracking are ignored. An assignment to you is highlighted. The detail shows the description (long texts collapsed) and, when there are no new changes, the latest comment and latest change. |
| **Tracked** | Finished issues (status category *Done*, such as Done or Closed) are grouped under *Done* at the bottom, collapsed by default; one with open changes stays in the regular list. *Stop tracking* works per issue and *Stop all* for the whole group (both can be undone); nothing is stopped automatically. A filter on key, title, assignee or status appears above the list once you track more than five issues. |
| **Processed** | Ticks off all open changes of an issue (button or key **E**); *Mark all processed* in Changed does this for every changed issue. This can be undone. In Changed, the selection jumps to the next changed issue. |
| **Own changes** | Not notified by default: stored silently as processed and marked in the timeline with *own change, not notified*. To test notifications with your own changes, turn off *Don't notify my own changes*. |
| **Notifications** | One system notification per changed issue; with more than 3 issues at once, a single summary. Clicking one opens the app on that issue's changes, on macOS also after a restart. *Send test notification* in Settings shows right away whether macOS displays notifications, or why not. **Note:** macOS only shows notifications from a signed app, so the development version (`npm start`) shows none; the built app does. |
| **Stale** | The query is `assignee = currentUser() AND statusCategory != Done AND updated <= -14d ORDER BY updated ASC`, so by default only your issues. Tick colleagues under *People* in Settings and it becomes `assignee IN (…)` with their account ids; also tick *Unassigned* and it becomes `(… OR assignee IS EMPTY)`. The people are all active people on the Jira site, without apps, customers and deactivated accounts. The Stale page filters on one or more of them, *Unassigned* included (nothing chosen = everyone); the filter survives a restart. Finished issues (status category *Done*) never count. Configurable: the number of days (1–365) and excluded statuses such as Backlog or On hold (none by default; the query then gets `AND status NOT IN (…)`; a status that does not exist in your Jira is skipped with a warning). Exclude projects in one field, by name or key, comma-separated, with `*` matching any text (none by default; `ARCHIVE-*` skips every project whose name or key starts with ARCHIVE-). The list is sorted *Oldest first* (by last update) by default; the button next to the filter switches to *Newest first*, and that choice is remembered. All results are fetched, up to 1000. The detail shows the issue's latest comment and latest change; *Track too* starts tracking it. |
| **Notes** | Loose one-liners (at most 255 characters; long ones wrap). Add (Enter), edit (click the text; Enter saves, Esc reverts), tick off (struck through, no longer counted, can no longer become an issue; can be turned back on) and delete (can be undone). New notes go at the top; reorder by dragging the grip on the left or with `⌥↑`/`⌥↓` in the text. *Create issue* (on every note that is not ticked off) opens a panel below the note where you adjust the title, project (the notes project, or the default project when that is empty; configurable) and type (*Task* by default, or its Dutch, French, German or Spanish name *Taak*, *Tâche*, *Aufgabe* or *Tarea*; otherwise the first plain type; never an epic or sub-task). Nothing goes to Jira until you click *Create* or press Enter in the panel (*Cancel* or Esc closes it). The issue goes into the backlog, the note disappears and the new issue is tracked right away. |
| **Settings** | Account (Jira URL, email address, API token, *Test connection*); checking (interval, default project, start at login); notifications (on/off, *Don't notify my own changes*, *Send test notification*); appearance (theme and language); stale issues (people, unassigned, days, excluded statuses, excluded projects); notes (project for new issues; the default project when empty); about (version, *Check for updates once a day*, *Check now*). Every change is saved immediately. Changing the Jira URL to another host clears the stored API token; enter it again. A refused address (plain http to a non-local host) is not saved: the stored URL and token stay. |
| **Appearance** | Theme *System*, *Light* or *Dark*, in Settings → Appearance or via the menu View → Theme. *System* follows the light or dark mode of macOS. The palette is warm and soft: stone tints in light, warm anthracite in dark. |
| **Language** | English, Dutch, French, German and Spanish. *System* (the default) follows the language of macOS and falls back to English when IssueMon doesn't have it. Change it in Settings → Appearance or via the menu View → Language. It is stored with the other settings and applies immediately to the window, all menus (the standard Edit, View and Window items too), the menu bar icon and new notifications. Error messages and warnings from the last check follow within a second, or at the next attempt while IssueMon waits after a failed check. |
| **Background** | Closing the window keeps IssueMon running and checking in the menu bar. The number of changed issues shows in the menu bar and on the Dock icon; the menu of the menu bar icon lists the changed issues (up to 10), click one to open it. Optionally the app starts at login, in the background (built app only). |
| **Updates** | Once a day (the first time a minute after launch; after the Mac wakes up when a day has passed) IssueMon asks GitHub for the latest release. When it is newer than the running version, a toast says *IssueMon 0.2.0 is available* with *View release* (opens the release page in your browser) and *Later* (hides that version until a still newer one appears). Nothing is downloaded or installed: update with `brew upgrade --cask issuemon` or from the [Releases page](https://github.com/fundament-agency/issuemon/releases). *Check for Updates…* in the app menu (right after *About*) and *Check now* in Settings → About check immediately and answer with a toast: *You're up to date*, the update, or *Could not check for updates* (no connection, GitHub's rate limit; never shown as a dialog). Switch the daily check off with *Check for updates once a day* in Settings → About. The development version (`npm start`) never checks on its own; *Check now* always works. |

Shortcuts: `j`/`k` or `↑`/`↓` to browse, `e` for processed, `o` to open in Jira, `u` to stop tracking, `/` or `⌘K` to paste, `⌘L` to track an issue (via the menu), `⌘R` to check now, `⌘1`–`⌘4` for Changed, Tracked, Stale and Notes, `⌘,` for Settings, `⌘Z` to undo the last action (while its toast is visible), `Esc` to go back or close, `⌥↑`/`⌥↓` in a note to move it, and `?` for this overview in the app.

## Storage and privacy

- All data lives in `~/.issuemon/issuemon.json`; the folder is readable only by you. Only Electron's own files, such as caches, live in `~/Library/Application Support/IssueMon`.
- The API token is stored in `~/.issuemon/issuemon.json` too. The file is readable only by you (mode 0600, the folder 0700; IssueMon also tightens an existing folder and file with wider permissions) and the token never reaches the renderer. Any program running under your account can read the file. The token is only sent to the site it was entered for, so changing the Jira URL to another host clears it.
- IssueMon stores nothing in the macOS keychain and does not use Chromium's own *IssueMon Safe Storage* key (`use-mock-keychain`), so macOS never shows a keychain prompt for it.
- Jira Cloud rejects `POST` requests with a browser User-Agent (`403 XSRF check failed`), so IssueMon always sends the User-Agent `IssueMon/<version>`.
- Network traffic goes only to your own Jira site, via the Jira Cloud REST API v3, plus the update check below. Only https is used; plain http is refused, except for local addresses (`localhost`, `127.0.0.1`, `[::1]`) for testing:
  - `issue` (create, only via *Create issue*)
  - `issue/createmeta/{project}/issuetypes`
  - `issue/bulkfetch`
  - `issue/{key}/changelog`
  - `issue/{key}/comment`
  - `search/jql`
  - `myself`
  - `users/search` (the list of people for Stale, at most once an hour)
- Once a day IssueMon asks `https://api.github.com/repos/fundament-agency/issuemon/releases/latest` whether a newer version exists. The request carries nothing about you or your Jira (no account, no issue), only the User-Agent `IssueMon/<version>` (GitHub sees your IP address, as with any request). Nothing is downloaded. Switch it off with *Check for updates once a day* in Settings → About.

## Development

### Running from source

```bash
npm install
npm start
```

Use the Node version in `.nvmrc`. The development version shows no notifications and never checks for updates on its own (see the table above).

### Mock Jira

To try the app without a real Jira:

```bash
npm run mock-jira
```

On the connect screen enter URL `http://localhost:4778`, email `demo@example.com`, token `demo`. Trigger changes at <http://localhost:4778/__mock>, then click *Check now* (⌘R) in IssueMon. `PORT=<port> npm run mock-jira` runs the mock Jira on another port.

### Tests

```bash
npm test            # unit and integration tests (against the mock Jira)
npm run test:e2e    # launches the real app via Playwright and clicks through all flows; screenshots in e2e/screenshots/
ISSUEMON_APP=dist/mac-arm64/IssueMon.app/Contents/MacOS/IssueMon npm run test:e2e   # same, against the built app
npm run icons       # regenerate the icons from SVG (scripts/make-icons.js)
```

`test/i18n.test.js` checks that every catalog in `src/shared/locales/` has exactly the keys of `en.js`, with the same plural forms and placeholders, and that its texts are translated. UI text lives only in those catalogs.

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
             Undo, without DOM
  shared/    keys.js: recognising issue keys · diff.js: word-level diff · inbox.js: the Changed, Tracked/Done and Stale lists,
             counts and selection · change.js: a change in words (labels, "assigned to you", notification and chip text) ·
             rules.js: note and project rules, intervals, themes, connected check, default issue type ·
             i18n.js: languages, the system-language fallback and the translator t(key, params) with plurals ·
             locales/: one message catalog per language (en.js is the source, nl.js …); all shared by main and renderer
  assets/    app and menu bar icons (generated by npm run icons)
scripts/     make-icons.js: renders the icons in build/ and src/assets/ from SVG
test/        node:test tests + support/mock-jira.js
e2e/         Playwright tests of the real Electron app
```

### Environment variables

Environment variables for tests:

- `ISSUEMON_HOME`: a different data folder (default `~/.issuemon`)
- `ISSUEMON_USER_DATA`: a different folder for Electron's own files; without `ISSUEMON_HOME` the data file lives there too
- `ISSUEMON_TOKEN`: token from the environment; it is not stored
- `ISSUEMON_E2E=1`: notifications are recorded instead of shown, external links are recorded instead of opened and the daily update check does not run; the window may exceed the screen, so small displays get the desktop layout
- `ISSUEMON_UPDATE_URL`: a different address for the update check's "latest release" request (default `https://api.github.com/repos/fundament-agency/issuemon/releases/latest`); the mock Jira answers at `/__releases/latest`, reporting the running version unless a test sets `jira.release`
- `ISSUEMON_APP`: path to the executable of a built app for `npm run test:e2e` (see above)

### Building an app

```bash
npm run dist
```

This produces four assets in `dist/`:

- `issuemon-<version>-arm64.dmg` and `issuemon-<version>-arm64.zip` (Apple silicon)
- `issuemon-<version>-x64.dmg` and `issuemon-<version>-x64.zip` (Intel)

Open a `.dmg` and drag `IssueMon.app` to Applications. For a quick build without an installer use `npm run pack`; the app is then at `dist/mac-arm64/IssueMon.app` (and `dist/mac/IssueMon.app` for Intel).

The app is *ad-hoc* signed and not notarized. Built locally, it just starts; on another Mac macOS blocks it the first time, see *First launch*.

## Contributing and security

Contributions are welcome: read [CONTRIBUTING.md](CONTRIBUTING.md) first. To report a vulnerability, follow [SECURITY.md](SECURITY.md) and do not open a public issue.

## License

MIT, see [LICENSE](LICENSE). Copyright © 2026 Fundament.
