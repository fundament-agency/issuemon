# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- A date in a description or comment that is not a millisecond timestamp, such as `2026-10-17` written through the REST API, no longer stops every check ("Invalid time value"). It shows as written, and a valid timestamp still shows as `YYYY-MM-DD`. Other unusual nodes in a description or comment no longer stop a check either. (#43)

## [0.3.0] - 2026-10-17

### Added

- A property-based fuzzer for contributors: `npm run fuzz` tests the shared modules, the window's HTML and the tracker against the mock Jira with random, seeded inputs, including network failures, Jira changing during a check and a switch between two sites. It shrinks a failure to a small case with a replay command. Its first findings are issues #40–#46.
- Linux support: each release has an AppImage for x64 (`issuemon-<version>-linux-x86_64.AppImage`) that starts without installation or `libfuse2`. Closing the window keeps IssueMon checking, with a tray icon where the desktop shows one; *Start at login* writes an XDG autostart entry that starts it hidden. Shortcut labels say Ctrl and Alt instead of ⌘ and ⌥, GNOME Keyring and KWallet never ask to be unlocked, and the e2e tests also run on Linux, under `xvfb-run`.

## [0.2.0] - 2026-10-17

### Added

- A new or edited comment that @-mentions you stands out in *Changed*: a *Mentions you* chip, an accent on the row and the mention highlighted in the timeline. Its notification says who mentioned you and where: "Sam mentioned you on ABC-1". Only a mention of your Jira account counts, not your name in plain text, a mention of someone else or a mention in the description.
- The issue detail shows labels and fix versions, the parent, sub-tasks with how many are done, and linked issues with their relationship and status. Clicking a related key selects it when you track it, or offers *Track*.

### Changed

- A notification leads with the change that matters most: an assignment to you, then a mention of you, then the rest, newest first. An issue assigned to you and commented on afterwards now says "ABC-1 was assigned to you" instead of only showing the comment. The summary for more than 3 changed issues counts what needs you, such as "5 issues changed · 2 assigned to you · 1 mentions you", and lists those keys first. *Changed* keeps its time order.

## [0.1.3] - 2026-10-17

### Fixed

- An edited comment now shows up in *Changed*, with a notification: "Sam edited a comment", with the new text, marked word by word when IssueMon saw the old text. Each edit counts once, and a save that leaves the text unchanged doesn't count.
- A tracked issue that was deleted, or that you can no longer see, now shows up once in *Changed*, with a notification: "No longer accessible (deleted, or you no longer have access)". Only a real answer from Jira counts: no connection, a server error or a temporary error on that issue never does, and neither does the first check after connecting or changing the account. If the issue comes back, its red row clears without a notification.

## [0.1.2] - 2026-10-16

### Changed

- A smaller app: it keeps Chromium's resources only for IssueMon's five languages (with British English and Latin American Spanish for regional variants), 46 MB less on disk.
- The app no longer contains SwiftShader, Chromium's software graphics for WebGL, which IssueMon doesn't use: 16 MB less on disk.
- Smaller downloads: Homebrew installs a 74 MB `.tar.xz` instead of a 129 MB `.zip` (Apple silicon; Intel 87 MB instead of 136 MB), and the `.dmg` is LZMA-compressed: 84 MB instead of 130 MB (Intel 99 MB instead of 136 MB).

### Removed

- The `.zip`, `latest-mac.yml` and blockmap files from the release: IssueMon has no auto-updater, so nothing used them.

### Fixed

- A note or setting you are editing survives the window refreshing in the background, for example after a check: a note is no longer saved before *Esc* discards the edit, and an edited setting is still saved when you leave the field.
- A newly tracked issue scrolls all the way into view, also when the list is redrawn while it scrolls.

## [0.1.1] - 2026-10-16

### Changed

- Installing or upgrading with Homebrew no longer needs *Open Anyway*: the cask removes the quarantine flag from the app. Only the `.dmg` still asks once.
- A shorter README, with every behaviour, path and shortcut kept.

## [0.1.0] - 2026-10-16

The first public release.

### Added

- Open-source project files: MIT licence, contributing guide, security policy and GitHub issue and pull request templates.
- GitHub Actions workflows that run the tests and build the release, and a Homebrew cask for installing the app.
- A check for new versions: once a day IssueMon asks GitHub for the latest release and tells you with a toast (*View release*, *Later*) when it is newer than the running version. *Check for Updates…* in the app menu and *Check now* in the new Settings → About check immediately, and the daily check can be switched off. IssueMon never downloads or installs anything; update with `brew upgrade --cask issuemon` or from the Releases page.
- Changing the Jira URL clears the stored API token, so it is never sent to another site.
- IssueMon only connects to Jira over https; plain http is refused, except for local addresses such as `localhost`.
- The licence notices of Electron and Chromium are shipped inside the app.

### Changed

- The app is called IssueMon.
- Generic defaults: the app no longer assumes a particular Jira site, project or team. Stale statuses, excluded projects and the notes project start empty, with example hints.
- The stale query ignores finished issues by status category instead of by status name.
- The app is built for Apple silicon and Intel Macs.
- English fixtures in the tests and the mock Jira.
- Windows and Linux builds are removed; IssueMon is macOS only.

### Removed

- The data and token migrations from pre-release versions.

[Unreleased]: https://github.com/fundament-agency/issuemon/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/fundament-agency/issuemon/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/fundament-agency/issuemon/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/fundament-agency/issuemon/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/fundament-agency/issuemon/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/fundament-agency/issuemon/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/fundament-agency/issuemon/releases/tag/v0.1.0
