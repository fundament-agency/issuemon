'use strict';
/* electron-builder artifactBuildCompleted hook. For each .dmg (one per architecture) it
 * - writes the app in it as a .tar.xz next to it: the archive Homebrew installs. electron-builder's own tar.xz target
 *   leaves out directory dates, so IssueMon.app would be dated 1970, and macOS goes by that date to notice a changed app;
 * - recompresses the image with LZMA (ULMO, macOS 10.15 and later), about a quarter smaller than electron-builder's zlib.
 *   Its dmg.format stops at ULFO, which is no smaller. This runs after electron-builder's dmg.sign, so a signed dmg
 *   would lose its signature here.
 * Configured as build.artifactBuildCompleted in package.json; scripts/verify-archives.sh checks the result. */

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const run = promisify(execFile);

/** Spotlight can still hold a volume that was just read; then retry by force, as electron-builder's dmg code does. */
async function detach(mount) {
  try {
    await run('hdiutil', ['detach', mount, '-quiet']);
  } catch {
    await new Promise(resolve => setTimeout(resolve, 3000));
    await run('hdiutil', ['detach', mount, '-force', '-quiet']);
  }
}

exports.default = async function artifactBuildCompleted({ file }) {
  if (!file.endsWith('.dmg')) return;

  const mount = await fs.mkdtemp(path.join(os.tmpdir(), 'issuemon-dmg-'));
  try {
    await run('hdiutil', ['attach', file, '-readonly', '-nobrowse', '-mountpoint', mount, '-quiet']);
    try {
      const apps = (await fs.readdir(mount)).filter(name => name.endsWith('.app'));
      // macOS's bsdtar, whatever tar comes first on PATH; without AppleDouble files and extended attributes, and
      // without the builder's user name
      await run('/usr/bin/tar', ['-c', '--xz', '--options', 'xz:compression-level=9', '--no-mac-metadata', '--uid', '0', '--gid', '0',
        '-f', file.replace(/\.dmg$/, '.tar.xz'), '-C', mount, ...apps]);
    } finally {
      await detach(mount);
    }
  } finally {
    await fs.rmdir(mount).catch(() => {}); // still attached after a failed detach: keep that error
  }

  const lzma = file.replace(/\.dmg$/, '.ulmo.dmg');
  await run('hdiutil', ['convert', file, '-format', 'ULMO', '-o', lzma, '-ov', '-quiet']);
  await fs.rename(lzma, file);
};
