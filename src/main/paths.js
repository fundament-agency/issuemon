'use strict';
/* Where IssueMon keeps its own data file: ~/.issuemon/issuemon.json (or ISSUEMON_HOME; with only ISSUEMON_USER_DATA
   set, that folder). Electron's own files (caches, Local Storage) stay in the userData folder. */

const nodeFs = require('node:fs');
const path = require('node:path');

const FILE_NAME = 'issuemon.json';

/** chmod that ignores a missing target and filesystems without modes. */
function tighten(fs, target, mode) {
  try { fs.chmodSync(target, mode); } catch { /* nothing to tighten */ }
}

/** Determines the data file path and creates the folder (0700, also tightening an existing one); an existing file is tightened to 0600.
 *  With only ISSUEMON_USER_DATA set (e.g. a demo against the mock Jira), the data file stays there and so does not
 *  move to ~/.issuemon, where it would take the place of the real data. */
function resolveDataFile({ env = process.env, homedir, userData, fs = nodeFs }) {
  const dir = env.ISSUEMON_HOME || (env.ISSUEMON_USER_DATA ? userData : path.join(homedir, '.issuemon'));
  const file = path.join(dir, FILE_NAME);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  tighten(fs, dir, 0o700); // mkdir applies the mode only to a folder it creates
  tighten(fs, file, 0o600);
  return file;
}

module.exports = { resolveDataFile };
