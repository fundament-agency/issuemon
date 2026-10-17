'use strict';
/* Seeded random numbers and value generators for the fuzzer. Deterministic: the same seed gives the same values. */

/** 32-bit hash of a string (FNV-1a), to derive a case seed from the run seed and a property name. */
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small, fast and good enough for test inputs. */
function createRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };

  const r = {
    seed,
    float: next,
    /** Integer in [min, max], both inclusive. */
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    bool: (p = 0.5) => next() < p,
    pick: list => list[Math.floor(next() * list.length)],
    /** [[weight, value], ...] → one value; a function value is called. */
    weighted(pairs) {
      const total = pairs.reduce((n, [w]) => n + w, 0);
      let roll = next() * total;
      for (const [w, v] of pairs) {
        roll -= w;
        if (roll < 0) return typeof v === 'function' ? v() : v;
      }
      const last = pairs[pairs.length - 1][1];
      return typeof last === 'function' ? last() : last;
    },
    array: (gen, min, max) => Array.from({ length: r.int(min, max) }, (_, i) => gen(i)),
    string: (alphabet, min, max) => Array.from({ length: r.int(min, max) }, () => r.pick(alphabet)).join(''),
    /** Shuffled copy. */
    shuffle(list) {
      const out = [...list];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };

  // Text pieces that tend to break text handling: whitespace of every kind, punctuation, markup, emoji, combining marks.
  const WORDS = ['the', 'a', 'Checkout', 'fix', 'euro', 'ok', 'PR', 'iOS', 'v2', 'ABC-12', 'café', 'naïve', 'Straße', 'İstanbul', '日本語', 'ok?', 'x'];
  const SPACES = [' ', ' ', ' ', '  ', '\t', '\n', '\n\n', '\r\n', ' ', ' ', '​', '　'];
  const PUNCT = ['.', ',', ';', ':', '!', '?', ')', '(', '...', '?!', '"', "'", '-', '—', '…'];
  const MARKUP = ['<', '>', '&', '"', "'", '<b>', '</p>', '<x-evil>', '&amp;', '&lt;', '{who}', '{n}', '${x}', '\\', '`'];
  const ODD = ['😀', '👩‍💻', '🇳🇱', 'é', '\u0000', '﻿', '\ud83d', '‮', 'ﬀ', 'Ⅻ'];

  /** Free text: words, whitespace, punctuation, markup and odd characters in a random mix. */
  r.text = (maxParts = 12) => {
    const parts = [];
    const n = r.int(0, maxParts);
    for (let i = 0; i < n; i++) {
      parts.push(r.weighted([
        [8, () => r.pick(WORDS)],
        [5, () => r.pick(SPACES)],
        [3, () => r.pick(PUNCT)],
        [2, () => r.pick(MARKUP)],
        [1, () => r.pick(ODD)],
        [1, () => r.string('abcXYZ019_-', 1, 6)],
      ]));
    }
    return parts.join('');
  };

  /** Text made of words and plain spaces only: for inputs where markup is not the point. */
  r.plainText = (maxWords = 12) => r.array(() => r.pick(WORDS), 0, maxWords).join(' ');

  return r;
}

module.exports = { createRng, hash };
