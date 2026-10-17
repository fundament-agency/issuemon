'use strict';
/* shared/diff.js: the word-level diff behind description changes and edited comments. */

const { wordDiff } = require('../../src/shared/diff');
const { fail } = require('../lib/property');

/** b from a: some words inserted, removed, replaced or re-spaced, as an edit would. */
function edit(r, a) {
  const words = a.split(/(\s+)/);
  const steps = r.int(0, 4);
  for (let i = 0; i < steps; i++) {
    const at = r.int(0, words.length);
    r.weighted([
      [3, () => words.splice(at, 0, r.pick([' ', '\n']), r.text(2))],
      [2, () => words.splice(at, r.int(1, 3))],
      [2, () => { words[at] = r.text(2); }],
      [1, () => { words[at] = r.pick([' ', '  ', '\n', '\n\n', '\t']); }],
      [1, () => { words[at] = `${words[at] ?? ''}${r.pick(['.', ',', '!', '?', ')'])}`; }],
    ]);
  }
  return words.join('');
}

function genPair(r) {
  return r.weighted([
    [5, () => { const a = r.text(16); return { a, b: edit(r, a) }; }],
    [2, () => ({ a: r.text(10), b: r.text(10) })],
    [1, () => { const a = r.text(6); return { a, b: a }; }],
    // Above the token limit: the diff falls back to one deletion and one insertion.
    [1, () => { const a = Array.from({ length: r.int(1400, 1700) }, (_, i) => `w${i % 97}`).join(' '); return { a, b: edit(r, a) }; }],
  ]);
}

const join = (parts, types) => parts.filter(p => types.includes(p.type)).map(p => p.text).join('');

const properties = [
  {
    name: 'diff.rebuild',
    description: 'same+del parts rebuild the old text and same+ins the new text; parts are never empty and never two of a kind in a row.',
    runs: 2500,
    gen: genPair,
    check({ a, b }) {
      const parts = wordDiff(a, b);
      if (join(parts, ['same', 'del']) !== a) fail('old-text-lost', 'same+del does not rebuild the old text', { a, parts });
      if (join(parts, ['same', 'ins']) !== b) fail('new-text-lost', 'same+ins does not rebuild the new text', { b, parts });
      if (parts.some(p => !p.text)) fail('empty-part', 'a part with empty text', { parts });
      if (parts.some((p, i) => i && parts[i - 1].type === p.type)) fail('unmerged-parts', 'two adjacent parts of the same type', { parts });
      if (a === b && parts.some(p => p.type !== 'same')) fail('equal-not-same', 'equal texts give a del or ins part', { parts });
    },
  },
  {
    name: 'diff.whitespace',
    description: 'When every changed part is whitespace (the UI then says "only whitespace changed"), the texts really differ only in whitespace.',
    runs: 2500,
    gen: genPair,
    check({ a, b }) {
      const parts = wordDiff(a, b);
      const onlyWhitespace = parts.length && parts.every(p => p.type === 'same' || !p.text.trim());
      const strip = s => s.replace(/\s+/g, '');
      if (onlyWhitespace && strip(a) !== strip(b)) fail('hidden-change', 'the diff claims a whitespace-only change, but the text changed', { a, b, parts });
    },
  },
];

module.exports = { properties };
