'use strict';
/* electron-builder afterPack hook: checks and trims the assembled app before it is signed.  Configured as build.afterPack in package.json. */

const fs = require('node:fs/promises');
const path = require('node:path');

/**
 * Where the assembled app keeps its resources and SwiftShader, Chromium's software Vulkan (16 MB). Chromium only loads
 * SwiftShader for WebGL without a usable GPU, and IssueMon draws no WebGL; without a GPU the window is still composited
 * in software. Removing a missing file fails the build, so an Electron upgrade that moves it doesn't silently bring the
 * 16 MB back.
 */
function layout({ appOutDir, packager, electronPlatformName }) {
  if (electronPlatformName === 'linux') {
    return {
      resources: path.join(appOutDir, 'resources'),
      swiftshader: ['libvk_swiftshader.so', 'vk_swiftshader_icd.json'].map(file => path.join(appOutDir, file)),
    };
  }
  const contents = path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents');
  const libraries = path.join(contents, 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Libraries');
  return {
    resources: path.join(contents, 'Resources'),
    swiftshader: ['libvk_swiftshader.dylib', 'vk_swiftshader_icd.json'].map(file => path.join(libraries, file)),
  };
}

exports.default = async function afterPack(context) {
  const { resources, swiftshader } = layout(context);

  // build.extraResources: the licence notices. electron-builder merely warns when a source is missing, and Electron's two
  // come from node_modules/electron/dist, which Electron only downloads on first use.
  const missing = [];
  for (const { to } of context.packager.config.extraResources || []) await fs.access(path.join(resources, to)).catch(() => missing.push(to));
  if (missing.length) throw new Error(`The app lacks ${missing.join(', ')}. Run \`npx install-electron\` first: Electron downloads its files on first use.`);

  for (const file of swiftshader) await fs.rm(file);
};
