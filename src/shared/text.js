/* Shortening user text without breaking it: cut at grapheme clusters (Intl.Segmenter), so an emoji, a combined emoji
 * (👩‍💻), a flag or a letter with its accents is never split in half, plus the initials of a name.
 * Lengths stay in UTF-16 units, like `String.length` and an input's `maxlength`.
 * Shared between main (CommonJS) and renderer (classic script). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IssuemonText = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const graphemes = text => Array.from(segmenter.segment(text), s => s.segment);

  /** The longest start of `text` of at most `max` UTF-16 units that ends between two grapheme clusters. */
  function truncate(text, max) {
    const s = String(text ?? '');
    if (s.length <= max) return s;
    let end = 0;
    for (const { segment } of segmenter.segment(s)) {
      if (end + segment.length > max) break;
      end += segment.length;
    }
    return s.slice(0, end);
  }

  /** `text` cut to at most `max` units, the last of them an ellipsis when something was cut off. */
  const clip = (text, max) => {
    const s = String(text ?? '');
    return s.length > max ? `${truncate(s, max - 1)}…` : s;
  };

  /** Initials of a display name: the first letter of its first and of its last part ("Sam Rivera" is "SR").
      Parts without a letter ("🌴", "(!)") are skipped, so a status emoji is no initial.
      A name without any letter gives its first grapheme; an empty name gives ''. */
  function initials(name) {
    const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
    const letters = parts.map(p => graphemes(p).find(g => /^\p{L}/u.test(g))).filter(Boolean);
    if (!letters.length) return parts.length ? graphemes(parts[0])[0] : '';
    return (letters[0] + (letters.length > 1 ? letters[letters.length - 1] : '')).toUpperCase();
  }

  return { truncate, clip, initials };
});
