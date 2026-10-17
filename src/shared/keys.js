/* Extracts issue keys from pasted text. Shared between main (CommonJS) and renderer (classic script). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IssuemonKeys = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KEY_RE = /\b([A-Za-z][A-Za-z0-9_]{1,9})-(\d{1,7})\b/g;
  const NUMBER_RE = /^#?(\d{1,7})$/;
  const WHOLE_KEY_RE = /^([A-Za-z][A-Za-z0-9_]{1,9})-(\d{1,7})$/;
  // The start of a link inside a token: a scheme, or a host name with a dot followed by a path.
  const LINK_RE = /[a-z][a-z0-9+.-]*:\/\/|(?<![\w.-])[a-z0-9-]+(?:\.[a-z0-9-]+)+\//i;
  // Punctuation that may follow a link in running text, such as "(see https://…/WEB-1)."
  const TRAILING_RE = /[)\]>.:;!'"]+$/;

  const decode = s => {
    try { return decodeURIComponent(s); } catch { return s; }
  };
  const keyOf = m => `${m[1].toUpperCase()}-${m[2]}`;
  const wholeKey = s => decode(s).replace(TRAILING_RE, '').match(WHOLE_KEY_RE);

  /**
   * The keys of one token. In a link only the key at the end of the path (/browse/ABC-1, …/issues/ABC-1,
   * …/queues/custom/1/ABC-1) and the value of selectedIssue count: never the host name (acme-sandbox-952), other
   * parameters (jql, focusedCommentId, page) or the fragment (#comment-10234). Text before the link is plain text.
   */
  function keysOfToken(token) {
    const link = LINK_RE.exec(token);
    if (!link) return [...token.matchAll(KEY_RE)].map(keyOf);
    const out = [...token.slice(0, link.index).matchAll(KEY_RE)].map(keyOf);
    const rest = token.slice(link.index + link[0].length);
    // After a scheme the host comes first; a host-form match already ended on the slash after the host.
    const afterHost = link[0].endsWith('//') ? rest.slice(rest.indexOf('/') < 0 ? rest.length : rest.indexOf('/')) : `/${rest}`;
    const [path, ...query] = afterHost.split('#')[0].split('?');
    const fromPath = wholeKey(path.split('/').filter(Boolean).pop() || '');
    if (fromPath) out.push(keyOf(fromPath));
    for (const param of query.join('?').split('&')) {
      const eq = param.indexOf('=');
      if (eq < 0 || decode(param.slice(0, eq)).toLowerCase() !== 'selectedissue') continue;
      const m = wholeKey(param.slice(eq + 1));
      if (m) out.push(keyOf(m));
    }
    return out;
  }

  /**
   * Supports /browse/ABC-1, ?selectedIssue=ABC-1 (in a link only the key at the end of the path and selectedIssue
   * count, not the host name, other parameters such as jql, or the fragment), bare keys (lowercase too) and several at once. A key is a project
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
    const found = tokens.map(keysOfToken);
    // Bare numbers only count in a list: every token is a key or a number, not running text.
    const list = tokens.every((token, i) => found[i].length || NUMBER_RE.test(token));
    tokens.forEach((token, i) => {
      for (const key of found[i]) out.add(key);
      const n = !found[i].length && list && project && token.match(NUMBER_RE);
      if (n) out.add(`${project}-${n[1]}`);
    });
    return [...out];
  }

  const isKey = key => /^[A-Z][A-Z0-9_]{1,9}-\d{1,7}$/.test(String(key));

  return { parseKeys, isKey };
});
