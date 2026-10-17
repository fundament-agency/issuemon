# Contributing

Thanks for helping out. This page explains how to run the app, run the tests and what a good change looks like. Please open an issue before you start on a large change, so we can agree on the direction first.

## Setup

1. Use the Node version in `.nvmrc` (`nvm use` or `fnm use`). Node 22 or newer works.
2. Install the dependencies and start the app:

   ```bash
   npm install
   npm start
   ```

3. To work without a real Jira, run the mock Jira in a second terminal:

   ```bash
   npm run mock-jira
   ```

   Then connect the app to `http://localhost:4778` with email `demo@example.com` and token `demo`. The *Mock Jira* section of the README explains how to trigger changes from the mock's control page.

If your shell sets `ELECTRON_RUN_AS_NODE=1` (some terminals embedded in Electron-based apps do), Electron starts as plain Node: no window, no error. Put `env -u ELECTRON_RUN_AS_NODE` in front of every Electron launch, for example `env -u ELECTRON_RUN_AS_NODE npm start`. The e2e tests handle this themselves.

## Tests

```bash
npm test          # unit tests, fast
npm run test:e2e  # drives the real Electron app against the mock Jira
npm run fuzz      # property-based fuzzer, random seeded inputs (not part of npm test; see the README)
```

- Unit and e2e tests run against the mock Jira in `test/support/mock-jira.js`. A new Jira field or endpoint goes in there too.
- The e2e test writes screenshots to `e2e/screenshots/`. Open them to see the interface without launching the app yourself.
- A full e2e run takes one to two minutes. A sub-test that gets stuck ends at the 180 s timeout, so allow for that in any command timeout.
- A few e2e sub-tests are occasionally flaky. If one fails, run the suite once more before you start investigating.

## Conventions

- **English only.** Commit messages, comments, test names and documentation are in English.
- **README.md is the spec.** When behaviour, a setting or a shortcut changes, the table in `README.md` changes in the same commit.
- **UI text lives in `src/shared/locales/`.** Every string the user sees goes into the catalogs, with `en.js` as the source language. Keep all five catalogs (English, Dutch, French, German and Spanish) complete; `test/i18n.test.js` enforces this.
- **One change per pull request**, and one commit per improvement.
- **Tests are green before every commit**: both `npm test` and `npm run test:e2e`.

## Releasing

For maintainers.

**Before the first release:** enable private vulnerability reporting in the repository settings (`SECURITY.md` points at it). The cask workflow pushes to the tap with a deploy key stored as the `TAP_DEPLOY_KEY` secret, which already exists.

1. Update `CHANGELOG.md`: move the entries from *Unreleased* to the new version with its date, and commit it. `npm version` refuses to run on a dirty working tree.
2. Run `npm version minor` (or `patch`). The `preversion` script runs `npm test`, then npm bumps the version in `package.json`, commits and tags `vX.Y.Z`. The first release is the exception: `package.json` is already at 0.1.0, so tag it by hand with `git tag -a v0.1.0 -m v0.1.0`.
3. Push the commit and the tag: `git push --follow-tags`.
4. The release workflow runs the unit tests, builds the macOS app for arm64 and x64 (signed ad hoc) as a `.dmg` and a `.tar.xz`, verifies the code signatures and the archives, runs the e2e tests against the built Apple silicon app and only then creates a **draft** GitHub release with the assets, using the GitHub CLI. A broken signature or archive, or a failing test, stops the workflow before anything is uploaded.
5. Write the release notes on the draft and publish it by hand.
6. Publishing triggers the workflow that updates the Homebrew cask in `fundament-agency/homebrew-tap`.

Never replace an asset in a published release: the Homebrew cask checks the file's SHA-256, and people may already have downloaded it. If something is wrong, cut a patch release instead.

The app is signed ad hoc and not notarized. On first launch from the `.dmg`, macOS asks the user to confirm in System Settings → Privacy & Security → Open Anyway; the Homebrew cask removes the quarantine flag, so it doesn't. Mention this in the release notes.
