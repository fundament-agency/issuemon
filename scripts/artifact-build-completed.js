'use strict';
/* electron-builder artifactBuildCompleted hook. For each .dmg (one per architecture) it
 * - writes the app in it as a .tar.xz next to it: the archive Homebrew installs. electron-builder's own tar.xz target
 *   leaves out directory dates, so IssueMon.app would be dated 1970, and macOS goes by that date to notice a changed app;
 * - recompresses the image with LZMA (ULMO, macOS 10.15 and later), about a quarter smaller than electron-builder's zlib.
 *   Its dmg.format stops at ULFO, which is no smaller.
 * Configured as build.artifactBuildCompleted in package.json. */

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const run = promisify(execFile);

exports.default = async function artifactBuildCompleted({ file }) {
  if (!file.endsWith('.dmg')) return;

  const mount = await fs.mkdtemp(path.join(os.tmpdir(), 'issuemon-dmg-'));
  await run('hdiutil', ['attach', file, '-readonly', '-nobrowse', '-mountpoint', mount, '-quiet']);
  try {
    const apps = (await fs.readdir(mount)).filter(name => name.endsWith('.app'));
    // Without AppleDouble files and extended attributes, and without the builder's user name
    await run('tar', ['-c', '--xz', '--options', 'xz:compression-level=9', '--no-mac-metadata', '--uid', '0', '--gid', '0',
      '-f', file.replace(/\.dmg$/, '.tar.xz'), '-C', mount, ...apps]);
  } finally {
    await run('hdiutil', ['detach', mount, '-quiet']);
    await fs.rmdir(mount);
  }

  const lzma = file.replace(/\.dmg$/, '.ulmo.dmg');
  await run('hdiutil', ['convert', file, '-format', 'ULMO', '-o', lzma, '-ov', '-quiet']);
  await fs.rename(lzma, file);
};
