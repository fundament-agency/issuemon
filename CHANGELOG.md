# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/fundament-agency/issuemon/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/fundament-agency/issuemon/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/fundament-agency/issuemon/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/fundament-agency/issuemon/releases/tag/v0.1.0
