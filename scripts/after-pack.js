'use strict';
/* electron-builder afterPack hook: checks and trims the assembled app before it is signed.  Configured as build.afterPack in package.json. */

const fs = require('node:fs/promises');
const path = require('node:path');

// The licence notices (build.extraResources). Electron's two come from node_modules/electron/dist, which Electron only
// downloads on first use; electron-builder merely warns when a source is missing, and the app would ship without them.
const NOTICES = ['LICENSE.txt', 'LICENSE.electron.txt', 'LICENSES.chromium.html'];

// SwiftShader, Chromium's software Vulkan (16 MB). Chromium only loads it for WebGL without a usable GPU, and IssueMon
// draws no WebGL; without a GPU the window is still composited in software. Removing a missing file fails the build,
// so an Electron upgrade that moves it doesn't silently bring the 16 MB back.
const SWIFTSHADER = ['libvk_swiftshader.dylib', 'vk_swiftshader_icd.json'];

exports.default = async function afterPack({ appOutDir, packager }) {
  const contents = path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents');

  const missing = [];
  for (const file of NOTICES) await fs.access(path.join(contents, 'Resources', file)).catch(() => missing.push(file));
  if (missing.length) throw new Error(`The app lacks ${missing.join(', ')}. Run \`npx install-electron\` first: Electron downloads its files on first use.`);

  const libraries = path.join(contents, 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Libraries');
  for (const file of SWIFTSHADER) await fs.rm(path.join(libraries, file));
};
