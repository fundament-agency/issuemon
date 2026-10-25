/* The Inbox list rules: what goes in Changed, Tracked/Done and Stale, in what order, the counts
 * and which issue is selected. Pure (no DOM, no clock), shared between main (CommonJS) and renderer (classic script). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IssuemonInbox = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The filter on Tracked only applies once its field is shown (6 or more tracked issues).
  const FILTER_MIN = 6;
  const LIST_VIEWS = ['changed', 'tracked', 'stale']; // the views with a list and a detail; the rest are pages
  // The id of the Unassigned group in the Stale filter, next to the account ids of people (those are hex or "712020:…", so no clash).
  const UNASSIGNED = 'unassigned';

  /** Strips diacritics and lowercases, so "cafe" also finds "Café". */
  const fold = s => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

  /* ---------- building blocks (also used by main) ---------- */

  /** The changes of a tracked issue that are not yet processed. */
  const pending = t => t.changes.filter(c => !c.processed);

  /** Changed: fetched and with pending changes. */
  const isChanged = t => !t.loading && !!t.issue && pending(t).length > 0;

  /** Done: status category done, no error and nothing pending; with pending changes the issue stays in the regular list, so those changes don't disappear. */
  const isDone = t => !t.loading && !t.error && t.issue?.statusCat === 'done' && !pending(t).length;

  const newestAt = cs => cs.reduce((m, c) => Math.max(m, c.at), 0);

  /** The changed issues, newest pending change first. */
  const changedList = tracked => tracked.filter(isChanged).sort((a, b) => newestAt(pending(b)) - newestAt(pending(a)));

  /** Quiet issues: loading first, then those with an error, then most recently updated. */
  const quietOrder = (a, b) =>
    (b.loading ? 1 : 0) - (a.loading ? 1 : 0) || (b.error ? 1 : 0) - (a.error ? 1 : 0) || (b.issue?.updated || 0) - (a.issue?.updated || 0);

  /** You first, then by name, with the collation of `locale` (a BCP 47 tag). */
  const sortPeople = (people, me, locale = 'en') => {
    const isMe = p => (p.accountId && p.accountId === me?.accountId ? 1 : 0);
    return [...people].sort((a, b) => isMe(b) - isMe(a) || String(a.name ?? '').localeCompare(String(b.name ?? ''), locale));
  };

  const matchesQuery = (t, q) => fold([t.key, t.issue?.summary, t.issue?.assignee?.name, t.issue?.status].filter(Boolean).join(' ')).includes(q);

  /* ---------- one computation for the renderer ---------- */

  /**
   * Everything the lists, the sidebar and the selection need.
   * @param {object} state publicState() from main: tracked, stale, notes, settings, me
   * @param {object} ui    view, trackedQuery, doneOpen, staleFilter
   * @param {{ locale?: string }} options locale: BCP 47 tag for sorting people
   * @returns {object} changed, tracked { active, done, query, filterShown, doneOpen }, stale { issues, people, unassigned, filter, counts, sort },
   *                   counts, keys, and shown(key)
   */
  function compute(state, ui, { locale } = {}) {
    const tracked = state.tracked;
    const changed = changedList(tracked);

    // Tracked: changed + active at the top, done grouped at the bottom, both passed through the filter.
    const filterShown = tracked.length >= FILTER_MIN;
    const query = filterShown ? fold((ui.trackedQuery || '').trim()) : '';
    const keep = list => (query ? list.filter(t => matchesQuery(t, query)) : list);
    const quiet = keep(tracked.filter(t => !isChanged(t)).sort(quietOrder));
    const active = [...keep(changed), ...quiet.filter(t => !isDone(t))];
    const done = quiet.filter(isDone);
    // With a filter the group is always open, otherwise you can't see what matches.
    const doneOpen = !!ui.doneOpen || !!query;

    // Stale: whose issues (the setting, or by default only you; Unassigned is a group of its own) and which filter within those.
    const chosen = state.settings?.stalePeople ?? [];
    const people = sortPeople(chosen.length ? chosen : state.me ? [state.me] : [], state.me, locale);
    const unassigned = !!state.settings?.staleUnassigned;
    // Groups no longer in the setting don't count: people you unticked, or Unassigned when those issues are no longer fetched.
    const filter = (ui.staleFilter || []).filter(id => (id === UNASSIGNED ? unassigned : people.some(p => p.accountId === id)));
    const groupOf = issue => (issue.assignee ? issue.assignee.accountId : UNASSIGNED);
    const allStale = state.stale?.issues ?? [];
    const dir = state.settings?.staleSort === 'oldest' ? 1 : -1; // sorted here, so flipping the order takes effect immediately
    const staleIssues = [...(filter.length ? allStale.filter(i => filter.includes(groupOf(i))) : allStale)]
      .sort((a, b) => dir * (a.updated - b.updated));
    // Stale issues per group, of everything fetched rather than the filtered list: the filter menu shows them next to each group.
    const groupCounts = Object.fromEntries([...people.map(p => p.accountId), ...(unassigned ? [UNASSIGNED] : [])].map(id => [id, 0]));
    for (const i of allStale) if (groupOf(i) in groupCounts) groupCounts[groupOf(i)]++;

    const counts = {
      changed: changed.length,
      tracked: tracked.length,
      stale: staleIssues.length, // what the list shows: after the person filter, so everyone without one
      notes: (state.notes || []).filter(n => !n.done).length,
    };

    // The keys j/k step through; a collapsed Done group is skipped.
    const keys = ui.view === 'changed' ? changed.map(t => t.key)
      : ui.view === 'tracked' ? [...active, ...(doneOpen ? done : [])].map(t => t.key)
      : ui.view === 'stale' ? staleIssues.map(i => i.key)
      : [];
    // A selected issue in the collapsed Done group stays selected: its detail stays visible.
    const held = ui.view === 'tracked' ? done.map(t => t.key) : [];
    const shown = key => keys.includes(key) || held.includes(key);

    return {
      changed,
      tracked: { active, done, query, filterShown, doneOpen },
      stale: { issues: staleIssues, people, unassigned, filter, counts: groupCounts, sort: state.settings?.staleSort },
      counts,
      keys,
      shown,
    };
  }

  /**
   * What must change in the UI state to make the selection consistent again, only the fields that change:
   * a pendingSelect that has loaded and is now visible gets selected (and the Done group opens if it is in there);
   * in a list view, a selection that is no longer visible becomes the first key (wide) or nothing (narrow).
   * @returns {object} patch for ui: selected, highlight, reveal, pendingSelect, doneOpen
   */
  function settle(state, ui, { wide, locale }) {
    const c = compute(state, ui, { locale });
    const patch = {};
    const set = (name, value) => { if (ui[name] !== value) patch[name] = value; };
    let selected = ui.selected;

    // Select a just-tracked issue as soon as the state shows it: main's reply can arrive before the state does.
    const ps = ui.pendingSelect, pt = ps && state.tracked.find(t => t.key === ps);
    if (pt && !pt.loading && c.shown(ps)) {
      if (isDone(pt)) set('doneOpen', true); // the row must exist to scroll to it
      selected = ps;
      set('selected', ps);
      set('highlight', ps);
      set('reveal', ps);
      set('pendingSelect', null);
    }
    if (LIST_VIEWS.includes(ui.view) && !c.shown(selected)) set('selected', wide ? c.keys[0] ?? null : null);
    return patch;
  }

  /** The next key, else the previous one, else null (where the selection jumps when an issue leaves the list). */
  const neighbour = (keys, key) => {
    const i = keys.indexOf(key);
    return keys[i + 1] ?? keys[i - 1] ?? null;
  };

  return { UNASSIGNED, pending, isChanged, isDone, changedList, compute, settle, neighbour, fold, sortPeople };
});
