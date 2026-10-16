'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { wordDiff } = require('../src/shared/diff');

const join = (parts, ...types) => parts.filter(p => types.includes(p.type)).map(p => p.text).join('');

test('wordDiff: equal texts give one same block', () => {
  assert.deepEqual(wordDiff('The card option is missing', 'The card option is missing'), [{ type: 'same', text: 'The card option is missing' }]);
  assert.deepEqual(wordDiff('', ''), []);
});

test('wordDiff: one changed word gives same, del, ins, same', () => {
  assert.deepEqual(wordDiff('the button is broken now', 'the button is fixed now'), [
    { type: 'same', text: 'the button is ' },
    { type: 'del', text: 'broken ' },
    { type: 'ins', text: 'fixed ' },
    { type: 'same', text: 'now' },
  ]);
});

test('wordDiff: adding at the end leaves the start untouched', () => {
  assert.deepEqual(wordDiff('The card option is not in the list.', 'The card option is not in the list. Only on mobile.'), [
    { type: 'same', text: 'The card option is not in the list.' },
    { type: 'ins', text: ' Only on mobile.' },
  ]);
});

test('wordDiff: a sentence that grows before the full stop is a pure insertion', () => {
  assert.deepEqual(wordDiff('Not in the list.', 'Not in the list for amounts under 5 USD.'), [
    { type: 'same', text: 'Not in the list' },
    { type: 'ins', text: ' for amounts under 5 USD' },
    { type: 'same', text: '.' },
  ]);
});

test('wordDiff: removing at the start', () => {
  assert.deepEqual(wordDiff('Note: the button is gone', 'the button is gone'), [
    { type: 'del', text: 'Note: ' },
    { type: 'same', text: 'the button is gone' },
  ]);
});

test('wordDiff: a completely different text gives del and ins', () => {
  assert.deepEqual(wordDiff('alpha beta', 'gamma delta epsilon'), [
    { type: 'del', text: 'alpha beta' },
    { type: 'ins', text: 'gamma delta epsilon' },
  ]);
});

test('wordDiff: an empty side gives only ins or del', () => {
  assert.deepEqual(wordDiff('', 'new'), [{ type: 'ins', text: 'new' }]);
  assert.deepEqual(wordDiff('old', ''), [{ type: 'del', text: 'old' }]);
});

test('wordDiff: whitespace is preserved, so the parts form the original text again', () => {
  const cases = [
    ['  First line\n\nSecond   line\t', 'First line\n\nThird  line  extra'],
    ['a b c', 'a  b c d'],
    ['x\ny', 'y\nx'],
    ['  ', 'word'],
  ];
  for (const [a, b] of cases) {
    const d = wordDiff(a, b);
    assert.equal(join(d, 'same', 'del'), a, `old: ${JSON.stringify(a)}`);
    assert.equal(join(d, 'same', 'ins'), b, `new: ${JSON.stringify(b)}`);
    d.forEach((p, i) => { assert.ok(p.text, 'no empty parts'); if (i) assert.notEqual(p.type, d[i - 1].type, 'equal neighbours are merged'); });
  }
});

test('wordDiff: huge texts give one del and one ins', () => {
  const a = Array.from({ length: 2000 }, (_, i) => `a${i}`).join(' ');
  const b = Array.from({ length: 2000 }, (_, i) => `b${i}`).join(' ');
  assert.deepEqual(wordDiff(a, b), [{ type: 'del', text: a }, { type: 'ins', text: b }]);
});

test('wordDiff: a small change in a long text stays a real diff', () => {
  const words = Array.from({ length: 2500 }, (_, i) => `w${i}`);
  const a = words.join(' ');
  const b = [...words.slice(0, 1200), 'extra', ...words.slice(1200)].join(' ');
  const d = wordDiff(a, b);
  assert.deepEqual(d.map(p => p.type), ['same', 'ins', 'same']);
  assert.equal(d[1].text, 'extra ');
});
