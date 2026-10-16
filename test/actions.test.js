const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../src/renderer/actions.js');

/** A fake clock and a state we keep ourselves; a call we resolve or fail ourselves. */
function setup(over = {}) {
  const clock = { t: 1000 };
  const state = { items: [] };
  const actions = create({ now: () => clock.t, getState: () => state, ...over });
  const deferred = () => {
    const d = {};
    d.promise = new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject; });
    return d;
  };
  return { clock, state, actions, deferred };
}

const setFlag = state => { state.flag = true; };
const newRevert = () => { const r = { n: 0 }; r.revert = () => { r.n++; }; return r; };

test('run applies apply right away and returns the result of call', async () => {
  const { state, actions } = setup();
  const result = await actions.run({ apply: setFlag, call: async () => 'done' });
  assert.equal(state.flag, true);
  assert.equal(result, 'done');
});

test('run applies apply synchronously, before call has finished', () => {
  const { state, actions, deferred } = setup();
  const d = deferred();
  actions.run({ apply: setFlag, call: () => d.promise });
  assert.equal(state.flag, true);
});

test('run without apply works too', async () => {
  const { actions } = setup();
  assert.equal(await actions.run({ call: async () => 7 }), 7);
});

test('an action whose undo returns something becomes the undo target', async () => {
  const { actions } = setup();
  const r = newRevert();
  assert.equal(actions.undoable(), false);
  await actions.run({ call: async () => ({ ids: [1] }), undo: res => (res.ids.length ? r : null) });
  assert.equal(actions.undoable(), true);
  assert.equal(actions.undo('key'), true);
  assert.equal(r.n, 1);
});

test('undo receives the result of call', async () => {
  const { actions } = setup();
  let gezien;
  await actions.run({ call: async () => ({ ids: [4, 5] }), undo: res => { gezien = res; return null; } });
  assert.deepEqual(gezien, { ids: [4, 5] });
});

test('an action without undo, or with an undo that returns null, leaves the existing target alone', async () => {
  const { actions } = setup();
  const r = newRevert();
  await actions.run({ call: async () => 1, undo: () => r });
  await actions.run({ call: async () => 2 });
  await actions.run({ call: async () => 3, undo: () => null });
  assert.equal(actions.undoable(), true);
  assert.equal(actions.undo('toast'), true);
  assert.equal(r.n, 1);
});

test('a new undoable action replaces the previous one: there is only one target', async () => {
  const { actions } = setup();
  const first = newRevert(), second = newRevert();
  await actions.run({ call: async () => 1, undo: () => first });
  await actions.run({ call: async () => 2, undo: () => second });
  assert.equal(actions.undo('key'), true);
  assert.equal(actions.undo('toast'), false);
  assert.equal(first.n, 0);
  assert.equal(second.n, 1);
});

test('overlay reapplies apply while the call is running, not after', async () => {
  const { actions, deferred } = setup();
  const d = deferred();
  const apply = state => { state.stalePeople = ['sam']; };
  const p = actions.run({ apply, call: () => d.promise });

  const push1 = { stalePeople: [] };
  actions.overlay(push1);
  assert.deepEqual(push1.stalePeople, ['sam']);

  d.resolve('ok');
  await p;
  const push2 = { stalePeople: [] };
  actions.overlay(push2);
  assert.deepEqual(push2.stalePeople, []);
});

test('overlay applies running actions in order', async () => {
  const { actions, deferred } = setup();
  const a = deferred(), b = deferred();
  actions.run({ apply: s => { s.log = [...(s.log || []), 'a']; }, call: () => a.promise });
  actions.run({ apply: s => { s.log = [...(s.log || []), 'b']; }, call: () => b.promise });
  const push = {};
  actions.overlay(push);
  assert.deepEqual(push.log, ['a', 'b']);
  a.resolve(); b.resolve();
});

test('undo runs revert once', async () => {
  const { actions } = setup();
  const r = newRevert();
  await actions.run({ call: async () => 1, undo: () => r });
  assert.equal(actions.undo('key'), true);
  assert.equal(actions.undo('toast'), false);
  assert.equal(r.n, 1);
  assert.equal(actions.undoable(), false);
});

test('the target expires after ttl', async () => {
  const { clock, actions } = setup({ ttl: 5000 });
  const r = newRevert();
  await actions.run({ call: async () => 1, undo: () => r });
  clock.t += 4999;
  assert.equal(actions.undoable(), true);
  clock.t += 1;
  assert.equal(actions.undoable(), false);
  assert.equal(actions.undo('toast'), false);
  assert.equal(r.n, 0);
});

test('the ttl counts from the moment call has finished', async () => {
  const { clock, actions, deferred } = setup({ ttl: 5000 });
  const d = deferred();
  const r = newRevert();
  const p = actions.run({ call: () => d.promise, undo: () => r });
  clock.t += 8000; // the call takes longer than the ttl
  d.resolve(1);
  await p;
  assert.equal(actions.undoable(), true);
});

test('menu within undoWindow after a key press is ignored, after it is not', async () => {
  const { clock, actions } = setup({ undoWindow: 150 });
  const first = newRevert(), second = newRevert();
  await actions.run({ call: async () => 1, undo: () => first });
  assert.equal(actions.undo('key'), true);
  await actions.run({ call: async () => 2, undo: () => second });
  clock.t += 100;
  assert.equal(actions.undo('menu'), false);
  assert.equal(second.n, 0);
  clock.t += 50; // exactly undoWindow after the key press
  assert.equal(actions.undo('menu'), true);
  assert.equal(second.n, 1);
});

test('menu within undoWindow after claimKey is ignored, after it is not', async () => {
  const { clock, actions } = setup({ undoWindow: 150 });
  const r = newRevert();
  await actions.run({ call: async () => 1, undo: () => r });
  actions.claimKey();
  clock.t += 149;
  assert.equal(actions.undo('menu'), false);
  assert.equal(r.n, 0);
  assert.equal(actions.undoable(), true);
  clock.t += 1;
  assert.equal(actions.undo('menu'), true);
  assert.equal(r.n, 1);
});

test('recentKey reports whether a key was just pressed, also after claimKey', () => {
  const { clock, actions } = setup({ undoWindow: 150 });
  assert.equal(actions.recentKey(), false);
  actions.claimKey();
  assert.equal(actions.recentKey(), true);
  clock.t += 150;
  assert.equal(actions.recentKey(), false);
});

test('the toast and the key are never blocked by the window', async () => {
  const { actions } = setup();
  const r = newRevert(), s = newRevert();
  actions.claimKey();
  await actions.run({ call: async () => 1, undo: () => r });
  assert.equal(actions.undo('toast'), true);
  await actions.run({ call: async () => 1, undo: () => s });
  assert.equal(actions.undo('key'), true);
});

test('a call that fails leaves no target and stops the overlay', async () => {
  const { actions, deferred } = setup();
  const existing = newRevert();
  await actions.run({ call: async () => 0, undo: () => existing });

  const d = deferred();
  const p = actions.run({ apply: setFlag, call: () => d.promise, undo: () => newRevert() });
  const push1 = {};
  actions.overlay(push1);
  assert.equal(push1.flag, true);

  d.reject(new Error('stuk'));
  await assert.rejects(p, /stuk/);
  const push2 = {};
  actions.overlay(push2);
  assert.equal(push2.flag, undefined);
  // the earlier target stays: the failed action replaces nothing
  assert.equal(actions.undo('key'), true);
  assert.equal(existing.n, 1);
});

test('a call that throws synchronously also stops the overlay', async () => {
  const { actions } = setup();
  await assert.rejects(actions.run({ apply: setFlag, call: () => { throw new Error('direct'); } }), /direct/);
  const push = {};
  actions.overlay(push);
  assert.equal(push.flag, undefined);
});
