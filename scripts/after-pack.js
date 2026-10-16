'use strict';
/* electron-builder afterPack hook: trims the assembled app before it is signed.  Configured as build.afterPack in package.json. */

const fs = require('node:fs/promises');
const path = require('node:path');

// SwiftShader, Chromium's software Vulkan (16 MB). Chromium only loads it for WebGL without a usable GPU, and IssueMon
// draws no WebGL; without a GPU the window is still composited in software. Removing a missing file fails the build,
// so an Electron upgrade that moves it doesn't silently bring the 16 MB back.
const SWIFTSHADER = ['libvk_swiftshader.dylib', 'vk_swiftshader_icd.json'];

exports.default = async function afterPack({ appOutDir, packager }) {
  const libraries = path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Libraries');
  for (const file of SWIFTSHADER) await fs.rm(path.join(libraries, file));
};
