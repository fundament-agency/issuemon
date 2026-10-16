const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CHANNELS } = require('../src/main/ipc.js');
const { Tracker } = require('../src/main/tracker.js');

/** Channels that main.js handles itself, because they have their own logic. */
const EXPLICIT = ['settings:token', 'open:jira', 'notify:test', 'open:url'];

/** Applies a channel's coercions to the given arguments, as registerIpc does. */
const coerce = (channel, ...args) => CHANNELS[channel].slice(1).map((c, i) => c(args[i]));

test('every method name in the table exists on Tracker', () => {
  for (const [channel, [method]] of Object.entries(CHANNELS)) {
    assert.equal(typeof Tracker.prototype[method], 'function', `${channel} → ${method}`);
  }
});

test('the table holds exactly the channels from the preload, minus the explicit ones', () => {
  const preload = fs.readFileSync(path.join(__dirname, '../src/preload/preload.js'), 'utf8');
  const channels = new Set([...preload.matchAll(/invoke\('([^']+)'/g)].map(m => m[1]));
  const expected = [...channels].filter(k => !EXPLICIT.includes(k)).sort();
  assert.deepEqual(Object.keys(CHANNELS).sort(), expected);
});

test('issues:mark turns one key into an array of one string; issues:unmark stringifies a list', () => {
  assert.deepEqual(coerce('issues:mark', 'ABC-1'), [['ABC-1']]);
  assert.deepEqual(coerce('issues:unmark', ['a', 2]), [['a', '2']]);
});

test('notes:done turns 1 into true and 0 into false', () => {
  assert.deepEqual(coerce('notes:done', 5, 1), ['5', true]);
  assert.deepEqual(coerce('notes:done', 'x', 0), ['x', false]);
});

test('notes:move turns "2" into the number 2', () => {
  assert.deepEqual(coerce('notes:move', 'n1', '2'), ['n1', 2]);
});

test('notes:issue without overrides gives an empty object', () => {
  assert.deepEqual(coerce('notes:issue', 'n1'), ['n1', {}]);
});

test('issues:add with undefined gives an empty text', () => {
  assert.deepEqual(coerce('issues:add', undefined), ['']);
});

test('people:load turns it into { force } and settings:save fills in an empty object', () => {
  assert.deepEqual(coerce('people:load', 1), [{ force: true }]);
  assert.deepEqual(coerce('people:load'), [{ force: false }]);
  assert.deepEqual(coerce('settings:save', null), [{}]);
});

test('arguments beyond the coercions are not passed on', () => {
  assert.equal(coerce('issues:track', 'A-1', 'extra').length, 1);
});
