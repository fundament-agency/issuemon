'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { default: afterPack } = require('../scripts/after-pack');

/** A packed app with just the framework's Libraries folder; cleaned up after the test. */
function setup(t, files) {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issuemon-after-pack-'));
  t.after(() => fs.rmSync(appOutDir, { recursive: true, force: true }));
  const libraries = path.join(appOutDir, 'IssueMon.app', 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Libraries');
  fs.mkdirSync(libraries, { recursive: true });
  for (const file of files) fs.writeFileSync(path.join(libraries, file), '');
  return { context: { appOutDir, packager: { appInfo: { productFilename: 'IssueMon' } } }, libraries };
}

test('afterPack removes SwiftShader and keeps the other libraries', async t => {
  const { context, libraries } = setup(t, ['libffmpeg.dylib', 'libvk_swiftshader.dylib', 'vk_swiftshader_icd.json']);
  await afterPack(context);
  assert.deepEqual(fs.readdirSync(libraries), ['libffmpeg.dylib']);
});

test('afterPack fails when SwiftShader is not where it expects', async t => {
  const { context } = setup(t, ['libffmpeg.dylib']);
  await assert.rejects(afterPack(context), { code: 'ENOENT' });
});
