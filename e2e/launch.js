'use strict';
/* How the e2e tests start IssueMon: from source, or the built app in ISSUEMON_APP
   (ISSUEMON_APP=dist/mac-arm64/IssueMon.app/Contents/MacOS/IssueMon npm run test:e2e). */

const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PACKAGED = process.env.ISSUEMON_APP ? path.resolve(ROOT, process.env.ISSUEMON_APP) : null;
// Linux: on a Wayland desktop Electron draws natively on Wayland, where Playwright's element screenshots hang
// and a resized window never reaches the page. Through X11 (XWayland, or Xvfb without a desktop) both work.
const PLATFORM_ARGS = process.platform === 'linux' ? ['--ozone-platform=x11'] : [];

/** Options for electron.launch() with the given environment. */
const launchOptions = env => ({
  executablePath: PACKAGED || require('electron'),
  args: [...PLATFORM_ARGS, ...(PACKAGED ? [] : [ROOT])],
  env,
});

module.exports = { launchOptions };
