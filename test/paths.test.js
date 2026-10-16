'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveDataFile } = require('../src/main/paths');
const { createStore } = require('../src/main/store');

/** Fresh temporary home and userData directories; cleaned up after the test. */
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issuemon-paths-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homedir = path.join(root, 'home');
  const userData = path.join(root, 'userData');
  fs.mkdirSync(homedir);
  fs.mkdirSync(userData);
  return { root, homedir, userData, userDataFile: path.join(userData, 'issuemon.json') };
}

test('defaults to ~/.issuemon', t => {
  const { homedir, userData } = setup(t);
  const file = resolveDataFile({ env: {}, homedir, userData });
  assert.equal(file, path.join(homedir, '.issuemon', 'issuemon.json'));
});

test('ISSUEMON_HOME overrides the directory', t => {
  const { root, homedir, userData } = setup(t);
  const custom = path.join(root, 'custom-dir');
  const file = resolveDataFile({ env: { ISSUEMON_HOME: custom }, homedir, userData });
  assert.equal(file, path.join(custom, 'issuemon.json'));
  assert.ok(fs.statSync(custom).isDirectory());
});

test('an empty ISSUEMON_HOME does not count', t => {
  const { homedir, userData } = setup(t);
  const file = resolveDataFile({ env: { ISSUEMON_HOME: '' }, homedir, userData });
  assert.equal(file, path.join(homedir, '.issuemon', 'issuemon.json'));
});

test('only ISSUEMON_USER_DATA: the data file lives in userData and its contents stay untouched', t => {
  const { homedir, userData, userDataFile } = setup(t);
  fs.writeFileSync(userDataFile, '{"demo":true}');
  const file = resolveDataFile({ env: { ISSUEMON_USER_DATA: userData }, homedir, userData });
  assert.equal(file, userDataFile);
  assert.equal(fs.readFileSync(userDataFile, 'utf8'), '{"demo":true}');
  assert.ok(!fs.existsSync(path.join(homedir, '.issuemon')));
});

test('creates the directory with mode 0700', t => {
  const { homedir, userData } = setup(t);
  const file = resolveDataFile({ env: {}, homedir, userData });
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
});

test('does nothing when there is no file', t => {
  const { homedir, userData } = setup(t);
  const file = resolveDataFile({ env: {}, homedir, userData });
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), []);
});

test('store creates a missing directory with mode 0700', t => {
  const { root } = setup(t);
  const file = path.join(root, 'new', 'issuemon.json');
  const store = createStore(file);
  store.data.x = 1;
  store.flush();
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { x: 1 });
});

test('tightens an existing directory (0755) to 0700', t => {
  const { homedir, userData } = setup(t);
  const dir = path.join(homedir, '.issuemon');
  fs.mkdirSync(dir, { mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  resolveDataFile({ env: {}, homedir, userData });
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test('tightens an existing data file (0644) to 0600', t => {
  const { homedir, userData } = setup(t);
  const file = path.join(homedir, '.issuemon', 'issuemon.json');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, '{}');
  fs.chmodSync(file, 0o644);
  resolveDataFile({ env: {}, homedir, userData });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a failing chmod does not stop the start', t => {
  const { homedir, userData } = setup(t);
  const fsStub = { ...fs, chmodSync() { throw Object.assign(new Error('not supported'), { code: 'ENOTSUP' }); } };
  const file = resolveDataFile({ env: {}, homedir, userData, fs: fsStub });
  assert.equal(file, path.join(homedir, '.issuemon', 'issuemon.json'));
});

test('store tightens an existing directory (0755) to 0700', t => {
  const { root } = setup(t);
  const dir = path.join(root, 'existing');
  fs.mkdirSync(dir);
  fs.chmodSync(dir, 0o755);
  const store = createStore(path.join(dir, 'issuemon.json'));
  store.flush();
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test('store writes the file with mode 0600, also over an old file and a stale tmp file with wider modes', t => {
  const { root } = setup(t);
  const file = path.join(root, 'issuemon.json');
  fs.writeFileSync(file, '{}');
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(`${file}.tmp`, 'stale');
  fs.chmodSync(`${file}.tmp`, 0o644);
  const store = createStore(file);
  store.data.x = 1;
  store.flush();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { x: 1 });
});
