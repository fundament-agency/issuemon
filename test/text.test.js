'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { truncate, clip, initials } = require('../src/shared/text');

const WOMAN_TECH = '👩‍💻'; // woman + zero-width joiner + laptop: one grapheme, 5 UTF-16 units
const NL = '🇳🇱'; // two regional indicators: one grapheme, 4 UTF-16 units
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** No lone surrogate, and the cut never falls inside a cluster of the original text. */
function assertWhole(result, original) {
  assert.ok(result.isWellFormed(), `lone surrogate in ${JSON.stringify(result)}`);
  const kept = result.replace(/…$/, '');
  assert.ok(original.startsWith(kept), `${JSON.stringify(result)} is not a start of ${JSON.stringify(original)}`);
  const boundaries = new Set([0]);
  let at = 0;
  for (const { segment } of segmenter.segment(original)) boundaries.add((at += segment.length));
  assert.ok(boundaries.has(kept.length), `cut inside a cluster: ${JSON.stringify(result)}`);
}

test('truncate: plain text is cut by length, short text is untouched', () => {
  assert.equal(truncate('abcdef', 3), 'abc');
  assert.equal(truncate('abc', 3), 'abc');
  assert.equal(truncate('', 3), '');
});

test('clip: plain text behaves as before', () => {
  assert.equal(clip('abcdef', 4), 'abc…');
  assert.equal(clip('abcd', 4), 'abcd');
});

test('clip: an emoji at the cut is dropped whole', () => {
  assert.equal(clip('Released 🚀🚀🚀', 11), 'Released …');
  assert.equal(clip('Released 🚀🚀🚀', 12), 'Released 🚀…');
});

test('clip and truncate: a combined emoji, a flag or a combining mark are never split, at every cut length', () => {
  for (const cluster of [WOMAN_TECH, NL, '🌴', '👍🏽', 'é']) {
    const text = `ab ${cluster}${cluster}${cluster} cd`;
    for (let n = 1; n <= text.length + 1; n++) {
      assertWhole(clip(text, n), text);
      assertWhole(truncate(text, n), text);
      assert.ok(clip(text, n).length <= n, `clip too long at ${n}`);
      assert.ok(truncate(text, n).length <= n, `truncate too long at ${n}`);
    }
  }
});

test('initials: first and last part of the name', () => {
  assert.equal(initials('Sam Rivera'), 'SR');
  assert.equal(initials('sam'), 'S');
  assert.equal(initials('  Sam   van der Rivera '), 'SR');
});

test('initials: parts without a letter are skipped, so a status emoji is no initial', () => {
  assert.equal(initials('🌴 Sam Rivera'), 'SR');
  assert.equal(initials('Sam Rivera 🌴'), 'SR');
  assert.equal(initials('🌴 Sam'), 'S');
  assert.equal(initials(`${WOMAN_TECH} Sam ${NL} Rivera`), 'SR');
});

test('initials: the first letter of a part, also when an emoji is glued to the name', () => {
  assert.equal(initials('🌴Sam Rivera'), 'SR');
  assert.equal(initials('Élodie Ångström'), 'ÉÅ');
});

test('initials: without any letter, the first grapheme of the name', () => {
  assert.equal(initials('🌴'), '🌴');
  assert.equal(initials(`${WOMAN_TECH} 🌴`), WOMAN_TECH);
  assert.equal(initials(NL), NL);
  assert.equal(initials('123 456'), '1');
});

test('initials: no name, no initials', () => {
  assert.equal(initials(''), '');
  assert.equal(initials('   '), '');
});
