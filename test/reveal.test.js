const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../src/renderer/reveal');

function setup() {
  let id = 0;
  const frames = new Map();
  const reveal = create({
    requestFrame: fn => { frames.set(++id, fn); return id; },
    cancelFrame: n => frames.delete(n),
  });
  const tick = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach(fn => fn());
  };
  const box = { top: 150, bottom: 430, height: 280, width: 380 };
  const row = (top = 500, height = 90) => {
    const list = new EventTarget();
    list.getBoundingClientRect = () => box;
    return {
      top, calls: [], list,
      closest: () => list,
      getBoundingClientRect() { return { top: this.top, bottom: this.top + height, height }; },
      scrollIntoView(options) { this.calls.push(options); },
    };
  };
  return { reveal, frames, tick, box, row };
}

test('a reveal resumes on the replacement row, without restarting an unchanged animation', () => {
  const { reveal, frames, tick, row } = setup();
  let current = row();
  const old = current;
  reveal.reveal(() => current);
  tick();
  assert.deepEqual(old.calls, [{ block: 'center', behavior: 'smooth' }]);
  old.top = 460; // partly through the animation, still out of view
  reveal.refresh();
  tick();
  assert.equal(old.calls.length, 1);
  current = row(old.top); // render restores scrollTop, but loses the native animation
  reveal.refresh();
  tick();
  assert.equal(current.calls.length, 1);
  current.top = 339; // the whole row is now visible
  current.list.dispatchEvent(new Event('scrollend'));
  tick();
  assert.equal(frames.size, 0);
  current = row(500); // later manual scrolling/rendering must not pin the selection
  reveal.refresh();
  tick();
  assert.equal(current.calls.length, 0);
});

test('a resize during the reveal updates the native scroll destination', () => {
  const { reveal, tick, box, row } = setup();
  const current = row();
  reveal.reveal(() => current);
  tick();
  box.height = 230;
  box.bottom = 380;
  reveal.refresh();
  tick();
  assert.equal(current.calls.length, 2);
  reveal.refresh();
  tick();
  assert.equal(current.calls.length, 2);
});

test('user input cancels a reveal so a later render does not restart it', () => {
  const { reveal, frames, tick, row } = setup();
  let current = row();
  reveal.reveal(() => current);
  tick();
  reveal.cancel();
  current = row();
  reveal.refresh();
  tick();
  assert.equal(current.calls.length, 0);
  assert.equal(frames.size, 0);
});

test('a new reveal supersedes the queued request, including before its first frame', () => {
  const { reveal, tick, row } = setup();
  const first = row(), second = row();
  reveal.reveal(() => first);
  reveal.reveal(() => second);
  tick();
  assert.equal(first.calls.length, 0);
  assert.equal(second.calls.length, 1);
});

test('a changed selection/view or a removed row stops the request', () => {
  const { reveal, frames, tick, row } = setup();
  let current = row();
  reveal.reveal(() => current);
  tick();
  current = null;
  reveal.refresh();
  tick();
  assert.equal(frames.size, 0);
});

test('a hidden list does not leave an animation frame loop running', () => {
  const { reveal, frames, tick, box, row } = setup();
  box.height = 0;
  const current = row();
  reveal.reveal(() => current);
  tick();
  assert.equal(current.calls.length, 0);
  assert.equal(frames.size, 0);
});

test('an already visible row still gets the original center animation once', () => {
  const { reveal, frames, tick, row } = setup();
  const current = row(200);
  reveal.reveal(() => current);
  tick();
  reveal.refresh();
  tick();
  assert.deepEqual(current.calls, [{ block: 'center', behavior: 'smooth' }]);
  assert.equal(frames.size, 0);
});

test('a row taller than the list completes once it fills the viewport', () => {
  const { reveal, frames, tick, row } = setup();
  const current = row(500, 400);
  reveal.reveal(() => current);
  tick();
  current.top = 100;
  reveal.refresh();
  tick();
  assert.equal(frames.size, 0);
});

test('unreachable geometry does not poll, and scrollend releases the request', () => {
  const { reveal, frames, tick, row } = setup();
  let current = row();
  reveal.reveal(() => current);
  tick();
  assert.equal(frames.size, 0); // no further render/resize: no animation frame work
  current.list.dispatchEvent(new Event('scrollend'));
  current = row();
  reveal.refresh();
  tick();
  assert.equal(current.calls.length, 0);
});

test('scrollend from a detached list cannot cancel the replacement reveal', () => {
  const { reveal, tick, row } = setup();
  let current = row();
  const old = current;
  reveal.reveal(() => current);
  tick();
  current = row();
  old.list.dispatchEvent(new Event('scrollend'));
  reveal.refresh();
  tick();
  assert.equal(current.calls.length, 1);
  old.list.dispatchEvent(new Event('scrollend'));
  current = row();
  reveal.refresh();
  tick();
  assert.equal(current.calls.length, 1);
});
