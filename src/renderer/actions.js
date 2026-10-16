/* The action runner: optimistic updates until main confirms, and the single Undo that ⌘Z, the menu and the toast share.
 * Pure (no DOM; the clock is injected as `now`, default Date.now, so tests can replace it). Classic script in the renderer
 * (window.IssuemonActions), requirable in node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IssuemonActions = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * @param {object}   [opts]
   * @param {function} [opts.now]        clock in ms (default Date.now)
   * @param {number}   [opts.ttl]        ms an action stays undoable (default 5000): as long as the toast is visible
   * @param {number}   [opts.undoWindow] ms after a ⌘Z key press within which the menu command counts as the same keystroke (default 150)
   * @param {function} [opts.getState]   the current renderer state, which apply works on
   */
  function create({ now = Date.now, ttl = 5000, undoWindow = 150, getState = () => undefined } = {}) {
    const running = new Set(); // running actions with an apply: { apply }
    let target = null;         // the one undoable thing: { revert, expires }
    let lastKey = -Infinity;   // when the last ⌘Z key press was

    /**
     * Runs an action: applies apply immediately, awaits call and registers the undo.
     * apply(state) must be idempotent: it is reapplied on every push from main while call is running.
     * undo(result) returns { revert } or null; non-null replaces the ⌘Z target.
     * @returns {Promise<*>} the result of call; an error is rethrown, without setting a target
     */
    async function run({ apply, call, undo }) {
      const entry = { apply };
      let result;
      try {
        if (apply) { running.add(entry); apply(getState()); }
        result = await call();
      } finally {
        running.delete(entry);
      }
      const u = undo?.(result);
      if (u) target = { revert: u.revert, expires: now() + ttl };
      return result;
    }

    /** Reapplies the running actions over a fresh state from main. */
    function overlay(state) {
      for (const { apply } of running) apply(state);
    }

    const undoable = () => !!target && now() < target.expires;

    /** Was there a ⌘Z key press just now? Then a menu command within undoWindow is the same keystroke. */
    const recentKey = () => now() - lastKey < undoWindow;

    /** ⌘Z in a text field: the browser does the undo itself, we only record the key press. */
    function claimKey() { lastKey = now(); }

    /**
     * Reverts the target, once; an expired target is dropped.
     * @param {'key'|'menu'|'toast'} via 'menu' is ignored right after a ⌘Z key press; 'key' records the key press
     * @returns {boolean} whether something was reverted
     */
    function undo(via) {
      if (via === 'menu' && recentKey()) return false;
      if (via === 'key') claimKey();
      if (!undoable()) { target = null; return false; }
      const { revert } = target;
      target = null;
      revert();
      return true;
    }

    return { run, overlay, undoable, undo, claimKey, recentKey };
  }

  return { create };
});
