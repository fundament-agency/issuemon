/* Word-by-word difference between two texts. Shared between main (CommonJS) and renderer (classic script). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IssuemonDiff = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_TOKENS = 3000; // above this count (old + new, after stripping the common start and end) O(n·m) is too slow

  /**
   * Tokens: a word with the whitespace before it (only for the first word) and after it, so the parts rebuild the text.
   * Punctuation at the end of a word is a token of its own: "euro." becomes "euro" and ".", so a sentence that grows
   * stays a pure insertion instead of a changed word.
   */
  function tokenize(text) {
    const out = [];
    for (const m of text.matchAll(/(\s*)(\S*?)([.,;:!?)]*)(\s+|$)/g)) {
      const [all, lead, word, punct, trail] = m;
      if (!all) continue;
      if (word && punct) out.push({ lead, word, trail: '' }, { lead: '', word: punct, trail });
      else out.push({ lead, word: word || punct, trail });
    }
    return out;
  }
  const full = t => t.lead + t.word + t.trail;

  /**
   * @param {string} a old text
   * @param {string} b new text
   * @returns {{type: 'same'|'del'|'ins', text: string}[]} contiguous parts; same+del make up a, same+ins make up b
   */
  function wordDiff(a, b) {
    a = String(a ?? ''); b = String(b ?? '');
    const A = tokenize(a), B = tokenize(b);
    const out = [];
    let dels = '', inss = '';
    const flush = () => {
      if (dels) out.push({ type: 'del', text: dels });
      if (inss) out.push({ type: 'ins', text: inss });
      dels = inss = '';
    };
    const same = text => { if (text) { flush(); out.push({ type: 'same', text }); } };
    // Equal words (regardless of whitespace) count as the same; a difference in whitespace becomes a small del/ins.
    const pair = (x, y) => {
      for (const part of ['lead', 'word', 'trail']) {
        if (x[part] === y[part]) same(x[part]);
        else { dels += x[part]; inss += y[part]; }
      }
    };

    let start = 0;
    while (start < A.length && start < B.length && A[start].word === B[start].word) pair(A[start], B[start++]);
    let endA = A.length, endB = B.length;
    const tail = [];
    while (endA > start && endB > start && A[endA - 1].word === B[endB - 1].word) tail.push([A[--endA], B[--endB]]);

    const n = endA - start, m = endB - start;
    if (n + m > MAX_TOKENS) {
      for (let i = start; i < endA; i++) dels += full(A[i]);
      for (let j = start; j < endB; j++) inss += full(B[j]);
    } else {
      // lcs[i][j]: length of the longest common subsequence of A[start + i..] and B[start + j..]
      const w = m + 1;
      const lcs = new Uint16Array((n + 1) * w);
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          lcs[i * w + j] = A[start + i].word === B[start + j].word ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
        }
      }
      let i = 0, j = 0;
      while (i < n || j < m) {
        if (i < n && j < m && A[start + i].word === B[start + j].word) pair(A[start + i++], B[start + j++]);
        else if (j >= m || (i < n && lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) dels += full(A[start + i++]);
        else inss += full(B[start + j++]);
      }
    }
    for (let k = tail.length - 1; k >= 0; k--) pair(tail[k][0], tail[k][1]);
    flush();

    // Merge adjacent parts of the same type.
    return out.reduce((acc, p) => {
      const last = acc[acc.length - 1];
      if (last && last.type === p.type) last.text += p.text; else acc.push({ ...p });
      return acc;
    }, []);
  }

  return { wordDiff };
});
