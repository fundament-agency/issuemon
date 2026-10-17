'use strict';
/* Generic shrinking of JSON-like values: smaller candidates first (drop array items, cut strings, zero numbers). */

/** Candidate values smaller than `value`, roughly from big to small steps. */
function* candidates(value) {
  if (Array.isArray(value)) {
    const n = value.length;
    // Drop chunks, from halves down to single items.
    for (let size = Math.floor(n / 2); size >= 1; size = Math.floor(size / 2)) {
      for (let start = 0; start + size <= n; start += size) yield [...value.slice(0, start), ...value.slice(start + size)];
    }
    for (let i = 0; i < n; i++) {
      for (const smaller of candidates(value[i])) yield [...value.slice(0, i), smaller, ...value.slice(i + 1)];
    }
    return;
  }
  if (typeof value === 'string') {
    const n = value.length;
    if (!n) return;
    yield '';
    for (let size = Math.floor(n / 2); size >= 1; size = Math.floor(size / 2)) {
      for (let start = 0; start + size <= n; start += size) yield value.slice(0, start) + value.slice(start + size);
    }
    return;
  }
  if (typeof value === 'number') {
    if (value !== 0 && Number.isFinite(value)) {
      yield 0;
      if (Number.isInteger(value) && Math.abs(value) > 1) yield Math.trunc(value / 2);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) {
      for (const smaller of candidates(value[k])) yield { ...value, [k]: smaller };
    }
  }
}

/**
 * Greedy shrink: keeps taking the first candidate that still fails with the same kind of error.
 * @param {*} input the failing input
 * @param {(input) => Promise<Error|null>} fails returns the error for a failing input, else null
 * @param {string} kind the failure kind to keep (so shrinking does not wander off to another bug)
 * `valid` rejects candidates the generator could never have made (such as a URL without its key).
 * @returns {Promise<{ input, error, steps }>}
 */
async function shrink(input, fails, kind, { maxTries = 400, deadline = Date.now() + 60_000, kindOf, valid = () => true } = {}) {
  let best = input;
  let bestError = null;
  let tries = 0;
  let steps = 0;
  let progress = true;
  while (progress && tries < maxTries && Date.now() < deadline) {
    progress = false;
    for (const candidate of candidates(best)) {
      if (!valid(candidate)) continue;
      if (++tries > maxTries || Date.now() > deadline) break;
      const err = await fails(candidate);
      if (err && kindOf(err) === kind) {
        best = candidate;
        bestError = err;
        steps++;
        progress = true;
        break;
      }
    }
  }
  return { input: best, error: bestError, steps };
}

module.exports = { shrink, candidates };
