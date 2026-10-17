# IssueMon

Electron app that tracks Jira issues and reports changes. Behaviour, shortcuts, storage, Jira endpoints, commands, environment variables and the layout of `src/` are in `README.md`: read it first for any question about what the app does or where code belongs.

## Conventions

- **Language**: everything in the repo is English: commit messages, comments, test names, README. UI text lives in message catalogs under `src/shared/locales/` (English, Dutch, French, German, Spanish), with English as the source language: every string the user sees goes into those catalogs.
- **README is the spec**: when behaviour, a setting or a shortcut changes, the table in `README.md` changes in the same commit.
- **Product decisions are the maintainer's**: they decide what the interface should do. Bundle those questions up front; build afterwards.
- **Green before every commit**: `npm test` and `npm run test:e2e` both pass, one commit per improvement.

## Testing

- Unit and e2e tests run against the mock Jira in `test/support/mock-jira.js`; a new Jira field or endpoint goes in there too.
- The e2e test writes screenshots to `e2e/screenshots/`; view them with Read to see the interface without launching the app yourself.
- When a sub-test in `e2e/app.e2e.js` fails, Electron stays open until the 180 s timeout; allow for that in your command's timeout.
- On Linux, run the e2e tests in a virtual display: `xvfb-run -a npm run test:e2e` (package `xvfb`). On the desktop itself, a blanked screen throttles Electron to about one frame a second and sub-tests time out.

## Launching Electron from a shell inside another Electron app

Terminals embedded in Electron-based tools set `ELECTRON_RUN_AS_NODE=1`; Electron then starts as plain Node, with no window and no error. If `npm start` shows no window, put `env -u ELECTRON_RUN_AS_NODE` in front of every Electron launch: `npm start`, `npm run icons`, `open dist/mac-arm64/IssueMon.app`. The e2e tests handle this themselves; `npm test` and `npm run dist` are unaffected.
