'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { default: afterPack } = require('../scripts/after-pack');

const NOTICES = ['LICENSE.txt', 'LICENSE.electron.txt', 'LICENSES.chromium.html'];
const LIBRARIES = ['libffmpeg.dylib', 'libvk_swiftshader.dylib', 'vk_swiftshader_icd.json'];

/** A packed app with just the licence notices and the framework's Libraries folder; cleaned up after the test. */
function setup(t, { notices = NOTICES, libraries: files = LIBRARIES } = {}) {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issuemon-after-pack-'));
  t.after(() => fs.rmSync(appOutDir, { recursive: true, force: true }));
  const contents = path.join(appOutDir, 'IssueMon.app', 'Contents');
  const resources = path.join(contents, 'Resources');
  const libraries = path.join(contents, 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Libraries');
  fs.mkdirSync(resources, { recursive: true });
  fs.mkdirSync(libraries, { recursive: true });
  for (const file of notices) fs.writeFileSync(path.join(resources, file), '');
  for (const file of files) fs.writeFileSync(path.join(libraries, file), '');
  return { context: { appOutDir, packager: { appInfo: { productFilename: 'IssueMon' } } }, libraries };
}

test('afterPack removes SwiftShader and keeps the other libraries', async t => {
  const { context, libraries } = setup(t);
  await afterPack(context);
  assert.deepEqual(fs.readdirSync(libraries), ['libffmpeg.dylib']);
});

test('afterPack fails when SwiftShader is not where it expects', async t => {
  const { context } = setup(t, { libraries: ['libffmpeg.dylib'] });
  await assert.rejects(afterPack(context), { code: 'ENOENT' });
});

test('afterPack fails when Electron\'s licence notices are missing, before it removes anything', async t => {
  const { context, libraries } = setup(t, { notices: ['LICENSE.txt'] });
  await assert.rejects(afterPack(context), /lacks LICENSE\.electron\.txt, LICENSES\.chromium\.html\. Run `npx install-electron` first/);
  assert.deepEqual(fs.readdirSync(libraries), LIBRARIES);
});
