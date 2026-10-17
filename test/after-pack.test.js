'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { default: afterPack } = require('../scripts/after-pack');

const NOTICES = ['LICENSE.txt', 'LICENSE.electron.txt', 'LICENSES.chromium.html'];
// Per platform: where the resources and SwiftShader live in the packed app, and the files next to SwiftShader
const PLATFORMS = {
  darwin: {
    resources: ['IssueMon.app', 'Contents', 'Resources'],
    libraries: ['IssueMon.app', 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Libraries'],
    files: ['libffmpeg.dylib', 'libvk_swiftshader.dylib', 'vk_swiftshader_icd.json'],
    kept: ['libffmpeg.dylib'],
  },
  linux: {
    resources: ['resources'],
    libraries: [],
    files: ['issuemon', 'libffmpeg.so', 'libvk_swiftshader.so', 'libvulkan.so.1', 'vk_swiftshader_icd.json'],
    kept: ['issuemon', 'libffmpeg.so', 'libvulkan.so.1'],
  },
};

/** A packed app with just the licence notices and the folder with SwiftShader; cleaned up after the test. */
function setup(t, platform, { notices = NOTICES, files = PLATFORMS[platform].files } = {}) {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issuemon-after-pack-'));
  t.after(() => fs.rmSync(appOutDir, { recursive: true, force: true }));
  const resources = path.join(appOutDir, ...PLATFORMS[platform].resources);
  const libraries = path.join(appOutDir, ...PLATFORMS[platform].libraries);
  fs.mkdirSync(resources, { recursive: true });
  fs.mkdirSync(libraries, { recursive: true });
  for (const file of notices) fs.writeFileSync(path.join(resources, file), '');
  for (const file of files) fs.writeFileSync(path.join(libraries, file), '');
  const extraResources = NOTICES.map(to => ({ from: `somewhere/${to}`, to }));
  const context = { appOutDir, electronPlatformName: platform, packager: { appInfo: { productFilename: 'IssueMon' }, config: { extraResources } } };
  const listed = () => fs.readdirSync(libraries).filter(name => !fs.statSync(path.join(libraries, name)).isDirectory()).sort();
  return { context, listed };
}

for (const platform of Object.keys(PLATFORMS)) {
  const { files, kept } = PLATFORMS[platform];

  test(`afterPack removes SwiftShader and keeps the other libraries (${platform})`, async t => {
    const { context, listed } = setup(t, platform);
    await afterPack(context);
    assert.deepEqual(listed(), kept);
  });

  test(`afterPack fails when SwiftShader is not where it expects (${platform})`, async t => {
    const { context } = setup(t, platform, { files: kept });
    await assert.rejects(afterPack(context), { code: 'ENOENT' });
  });

  test(`afterPack fails when extraResources, such as Electron's licence notices, are missing, before it removes anything (${platform})`, async t => {
    const { context, listed } = setup(t, platform, { notices: ['LICENSE.txt'] });
    await assert.rejects(afterPack(context), /lacks LICENSE\.electron\.txt, LICENSES\.chromium\.html\. Run `npx install-electron` first/);
    assert.deepEqual(listed(), [...files].sort());
  });
}
