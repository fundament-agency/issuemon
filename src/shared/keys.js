/* Extracts issue keys from pasted text. Shared between main (CommonJS) and renderer (classic script). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IssuemonKeys = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KEY_RE = /\b([A-Za-z][A-Za-z0-9_]{1,9})-(\d{1,7})\b/g;
  const NUMBER_RE = /^#?(\d{1,7})$/;

  /**
   * Supports /browse/ABC-1, ?selectedIssue=ABC-1, bare keys (lowercase too) and several at once. A key is a project
   * of 2–10 letters, digits or _ starting with a letter, a hyphen and 1–7 digits.
   * A bare number ("123" or "#123", up to 7 digits) gets the default project prepended, also next to full keys,
   * but only if the whole text is a list (every word, split on whitespace, commas and semicolons, contains a key or
   * is a number). In running text ("Takes 2 days") numbers are not issues. Without a default project bare numbers are ignored.
   * @param {string} text
   * @param {string} [defaultProject]
   * @returns {string[]} unique keys in uppercase, in order of appearance
   */
  function parseKeys(text, defaultProject) {
    const out = new Set();
    const project = String(defaultProject || '').trim().toUpperCase();
    // Token by token, so the order of appearance is kept. A token containing a key yields only that key (or keys).
    const tokens = String(text || '').split(/[\s,;]+/).filter(Boolean);
    const found = tokens.map(token => [...token.matchAll(KEY_RE)]);
    // Bare numbers only count in a list: every token is a key or a number, not running text.
    const list = tokens.every((token, i) => found[i].length || NUMBER_RE.test(token));
    tokens.forEach((token, i) => {
      for (const m of found[i]) out.add(`${m[1].toUpperCase()}-${m[2]}`);
      const n = !found[i].length && list && project && token.match(NUMBER_RE);
      if (n) out.add(`${project}-${n[1]}`);
    });
    return [...out];
  }

  const isKey = key => /^[A-Z][A-Z0-9_]{1,9}-\d{1,7}$/.test(String(key));

  return { parseKeys, isKey };
});
