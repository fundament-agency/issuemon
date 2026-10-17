'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HIDDEN_FLAG, autostartFile, desktopEntry, execArg, refreshAutostart, setAutostart } = require('../src/main/autostart');

test('the entry lives in $XDG_CONFIG_HOME/autostart, else ~/.config/autostart', () => {
  assert.equal(autostartFile({ env: {}, homedir: '/home/sam' }), '/home/sam/.config/autostart/issuemon.desktop');
  assert.equal(autostartFile({ env: { XDG_CONFIG_HOME: '/cfg' }, homedir: '/home/sam' }), '/cfg/autostart/issuemon.desktop');
});

test('the entry starts the executable hidden', () => {
  const entry = desktopEntry('/home/sam/Apps/issuemon-0.3.0-linux-x86_64.AppImage');
  assert.match(entry, /^\[Desktop Entry\]\n/);
  assert.match(entry, /\nType=Application\n/);
  assert.match(entry, /\nName=IssueMon\n/);
  assert.match(entry, new RegExp(`\\nExec=/home/sam/Apps/issuemon-0\\.3\\.0-linux-x86_64\\.AppImage ${HIDDEN_FLAG}\\n`));
});

test('Exec arguments are quoted as the Desktop Entry Specification asks', () => {
  assert.equal(execArg('/opt/IssueMon/issuemon'), '/opt/IssueMon/issuemon');
  assert.equal(execArg('/home/sam/My Apps/IssueMon.AppImage'), '"/home/sam/My Apps/IssueMon.AppImage"');
  // Quoting escapes ", `, $ and \ with a backslash; the string escape rule then doubles every backslash
  assert.equal(execArg('/a/$HOME `x` "y" \\z'), '"/a/\\\\$HOME \\\\`x\\\\` \\\\"y\\\\" \\\\\\\\z"');
  assert.equal(execArg('/a/100%/b'), '/a/100%%/b');
  assert.equal(execArg('/a b/100%'), '"/a b/100%%"');
});

test('on writes the entry, also into a missing folder and over an old one; off removes it, also when it is missing', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'issuemon-autostart-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = autostartFile({ env: {}, homedir: home });
  setAutostart({ on: true, file, exec: '/old/IssueMon.AppImage' });
  setAutostart({ on: true, file, exec: '/new/IssueMon.AppImage' });
  assert.equal(fs.readFileSync(file, 'utf8'), desktopEntry('/new/IssueMon.AppImage'));
  setAutostart({ on: false, file, exec: '/new/IssueMon.AppImage' });
  assert.equal(fs.existsSync(file), false);
  setAutostart({ on: false, file, exec: '/new/IssueMon.AppImage' });
});

test('at start an existing entry follows a moved executable and keeps the desktop\'s own switches; a removed one stays removed', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'issuemon-autostart-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = autostartFile({ env: {}, homedir: home });
  refreshAutostart({ file, exec: '/new/IssueMon.AppImage' });
  assert.equal(fs.existsSync(file), false);
  setAutostart({ on: true, file, exec: '/old/IssueMon.AppImage' });
  fs.appendFileSync(file, 'Hidden=true\n'); // switched off in the desktop's autostart settings
  refreshAutostart({ file, exec: '/new/IssueMon.AppImage' });
  const entry = fs.readFileSync(file, 'utf8');
  assert.match(entry, new RegExp(`\\nExec=/new/IssueMon\\.AppImage ${HIDDEN_FLAG}\\n`));
  assert.doesNotMatch(entry, /old/);
  assert.match(entry, /\nHidden=true\n/);
});
