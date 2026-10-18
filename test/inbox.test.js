'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { UNASSIGNED, pending, isChanged, isDone, changedList, compute, settle, neighbour, fold, sortPeople } = require('../src/shared/inbox');

/* ---------- fixtures ---------- */

const ME = { accountId: 'me', name: 'Demo User' };
const SAM = { accountId: 'sam', name: 'Sam Rivera' };
const ASA = { accountId: 'asa', name: 'Åsa Ångström' };

/** A change at time `at`; `processed: true` is already ticked off. */
const ch = (at, processed = false) => ({ id: `c${at}`, field: 'status', at, processed });

/** A tracked issue. `changes` is a list of changes; unless `issue: null` is passed it gets a fetched issue. */
function tr(key, { changes = [], cat = 'indeterminate', updated = 1000, status = 'In progress', summary = `Title of ${key}`, assignee = ME, ...rest } = {}) {
  return { key, changes, issue: { key, summary, status, statusCat: cat, updated, assignee }, ...rest };
}
const loadingTr = key => ({ key, loading: true, changes: [] });
const errorTr = (key, extra = {}) => ({ key, error: 'Not found', changes: [], issue: null, ...extra });

const staleIssue = (key, updated, assignee = ME) => ({ key, summary: key, updated, assignee });

function state(over = {}) {
  return {
    tracked: [], stale: { issues: [] }, notes: [], me: ME,
    settings: { stalePeople: [], staleSort: 'oldest' }, status: { state: 'idle' }, ...over,
  };
}
function ui(over = {}) {
  return { view: 'changed', selected: null, trackedQuery: '', doneOpen: false, staleFilter: [], pendingSelect: null, ...over };
}
const keysOf = list => list.map(x => x.key);

/** Six issues, so the Tracked filter is visible. */
const six = (extra = []) => [tr('A-1'), tr('A-2'), tr('A-3'), tr('A-4'), tr('A-5'), tr('A-6'), ...extra];

/* ---------- building blocks ---------- */

test('pending: only the changes not yet ticked off', () => {
  const t = tr('A-1', { changes: [ch(1, true), ch(2), ch(3)] });
  assert.deepEqual(pending(t).map(c => c.at), [2, 3]);
});

test('isChanged: a loaded issue with open changes', () => {
  assert.equal(isChanged(tr('A-1', { changes: [ch(1)] })), true);
  assert.equal(isChanged(tr('A-1', { changes: [ch(1, true)] })), false);
  assert.equal(isChanged({ ...tr('A-1', { changes: [ch(1)] }), loading: true }), false);
});

test('isChanged: without a fetched issue a change does not count (the renderer definition)', () => {
  assert.equal(isChanged(errorTr('A-1', { changes: [ch(1)] })), false);
});

test('isDone: status category done, no error, nothing open', () => {
  assert.equal(isDone(tr('A-1', { cat: 'done' })), true);
  assert.equal(isDone(tr('A-1', { cat: 'indeterminate' })), false);
  assert.equal(isDone(tr('A-1', { cat: 'done', error: 'stuk' })), false);
  assert.equal(isDone(tr('A-1', { cat: 'done', changes: [ch(1)] })), false);
  assert.equal(isDone(tr('A-1', { cat: 'done', changes: [ch(1, true)] })), true);
  assert.equal(isDone(loadingTr('A-1')), false);
});

/* ---------- Changed ---------- */

test('Changed: the newest open change first', () => {
  const tracked = [
    tr('A-1', { changes: [ch(100)] }),
    tr('A-2', { changes: [ch(300)] }),
    tr('A-3', { changes: [ch(200), ch(50)] }),
    tr('A-4'),
  ];
  assert.deepEqual(keysOf(changedList(tracked)), ['A-2', 'A-3', 'A-1']);
  assert.deepEqual(keysOf(compute(state({ tracked }), ui()).changed), ['A-2', 'A-3', 'A-1']);
});

test('Changed: a ticked-off change does not count for the order', () => {
  const tracked = [
    tr('A-1', { changes: [ch(100), ch(900, true)] }),
    tr('A-2', { changes: [ch(300)] }),
  ];
  assert.deepEqual(keysOf(changedList(tracked)), ['A-2', 'A-1']);
});

test('Changed: changedList does not modify its input', () => {
  const tracked = [tr('A-1', { changes: [ch(100)] }), tr('A-2', { changes: [ch(300)] })];
  changedList(tracked);
  assert.deepEqual(keysOf(tracked), ['A-1', 'A-2']);
});

/* ---------- Tracked and Done ---------- */

test('Tracked: changed first, then the quiet list: loading, error, then by updated (newest first)', () => {
  const tracked = [
    tr('Q-OLD', { updated: 100 }),
    tr('Q-NEW', { updated: 900 }),
    errorTr('Q-ERR'),
    loadingTr('Q-LOAD'),
    tr('C-1', { changes: [ch(5)] }),
  ];
  const c = compute(state({ tracked }), ui({ view: 'tracked' }));
  assert.deepEqual(keysOf(c.tracked.active), ['C-1', 'Q-LOAD', 'Q-ERR', 'Q-NEW', 'Q-OLD']);
});

test('Done: a done issue is in the Done group, not in the active list', () => {
  const tracked = [tr('A-1'), tr('D-1', { cat: 'done', updated: 500 }), tr('D-2', { cat: 'done', updated: 900 })];
  const c = compute(state({ tracked }), ui({ view: 'tracked' }));
  assert.deepEqual(keysOf(c.tracked.active), ['A-1']);
  assert.deepEqual(keysOf(c.tracked.done), ['D-2', 'D-1']);
});

test('Done: a done issue with open changes stays in the regular list', () => {
  const tracked = [tr('D-1', { cat: 'done', changes: [ch(10)] }), tr('A-1')];
  const c = compute(state({ tracked }), ui({ view: 'tracked' }));
  assert.deepEqual(keysOf(c.tracked.active), ['D-1', 'A-1']);
  assert.deepEqual(c.tracked.done, []);
});

test('Done: a done issue with an error, or one still loading, is not in Done', () => {
  const tracked = [tr('D-1', { cat: 'done', error: 'stuk' }), loadingTr('D-2')];
  const c = compute(state({ tracked }), ui({ view: 'tracked' }));
  assert.deepEqual(c.tracked.done, []);
});

test('Done: collapsed by default and opens with doneOpen', () => {
  const tracked = [tr('D-1', { cat: 'done' })];
  assert.equal(compute(state({ tracked }), ui({ view: 'tracked' })).tracked.doneOpen, false);
  assert.equal(compute(state({ tracked }), ui({ view: 'tracked', doneOpen: true })).tracked.doneOpen, true);
});

/* ---------- Filter on Tracked ---------- */

test('filter: only visible from 6 tracked issues', () => {
  const vijf = compute(state({ tracked: six().slice(0, 5) }), ui({ view: 'tracked' }));
  const zes = compute(state({ tracked: six() }), ui({ view: 'tracked' }));
  assert.equal(vijf.tracked.filterShown, false);
  assert.equal(zes.tracked.filterShown, true);
});

test('filter: below 6 issues the text in the field is ignored', () => {
  const tracked = six().slice(0, 5);
  const c = compute(state({ tracked }), ui({ view: 'tracked', trackedQuery: 'does not exist' }));
  assert.equal(c.tracked.query, '');
  assert.equal(c.tracked.active.length, 5);
  assert.equal(c.tracked.doneOpen, false);
});

test('filter: by key, title, person and status', () => {
  const tracked = six([
    tr('WEB-77', { summary: 'Checkout broken', assignee: SAM, status: 'Review' }),
    tr('API-9', { summary: 'Rate limit', assignee: ME, status: 'Blocked' }),
  ]);
  const q = trackedQuery => keysOf(compute(state({ tracked }), ui({ view: 'tracked', trackedQuery })).tracked.active);
  assert.deepEqual(q('web-77'), ['WEB-77']);
  assert.deepEqual(q('checkout'), ['WEB-77']);
  assert.deepEqual(q('rivera'), ['WEB-77']);
  assert.deepEqual(q('blocked'), ['API-9']);
  assert.deepEqual(q('  RATE  '), ['API-9']); // surrounding spaces and case do not count
});

test('filter: diacritics and case are folded', () => {
  const tracked = six([tr('WEB-5', { summary: 'Update café menu', assignee: ASA })]);
  const q = trackedQuery => keysOf(compute(state({ tracked }), ui({ view: 'tracked', trackedQuery })).tracked.active);
  assert.deepEqual(q('cafe'), ['WEB-5']);
  assert.deepEqual(q('CAFÉ'), ['WEB-5']);
  assert.deepEqual(q('angstrom'), ['WEB-5']);
  assert.equal(fold('Ångström É'), 'angstrom e');
});

test('filter: also applies to changed issues and to Done', () => {
  const tracked = six([
    tr('X-1', { summary: 'Keyword first', changes: [ch(10)] }),
    tr('X-2', { summary: 'Keyword done', cat: 'done' }),
    tr('X-3', { summary: 'Something else', cat: 'done' }),
  ]);
  const c = compute(state({ tracked }), ui({ view: 'tracked', trackedQuery: 'keyword' }));
  assert.deepEqual(keysOf(c.tracked.active), ['X-1']);
  assert.deepEqual(keysOf(c.tracked.done), ['X-2']);
});

test('filter: with a filter the Done group is always open', () => {
  const tracked = six([tr('X-2', { summary: 'Keyword', cat: 'done' })]);
  const c = compute(state({ tracked }), ui({ view: 'tracked', trackedQuery: 'keyword', doneOpen: false }));
  assert.equal(c.tracked.doneOpen, true);
  assert.deepEqual(c.keys, ['X-2']); // so j/k reaches it
});

/* ---------- Stale ---------- */

test('stale: only you by default; you first, then by name (nl collation)', () => {
  const none = compute(state({ me: ME }), ui());
  assert.deepEqual(none.stale.people, [ME]);
  const withoutMe = compute(state({ me: null }), ui());
  assert.deepEqual(withoutMe.stale.people, []);
  const people = [SAM, { accountId: 'ben', name: 'Ben Carter' }, ME, ASA];
  const c = compute(state({ settings: { stalePeople: people, staleSort: 'oldest' } }), ui());
  assert.deepEqual(c.stale.people.map(p => p.accountId), ['me', 'asa', 'ben', 'sam']);
});

test('stale: sortPeople puts you first and sorts the rest by name', () => {
  assert.deepEqual(sortPeople([SAM, ME, ASA], ME).map(p => p.accountId), ['me', 'asa', 'sam']);
  assert.deepEqual(sortPeople([SAM, ASA], null).map(p => p.accountId), ['asa', 'sam']);
});

test('stale: people are sorted with the collation of the given locale', () => {
  const people = [{ accountId: 'z', name: 'Zoë' }, { accountId: 'a', name: 'Ärla' }];
  assert.deepEqual(sortPeople(people, null, 'de-DE').map(p => p.accountId), ['a', 'z']);
  assert.deepEqual(sortPeople(people, null, 'sv-SE').map(p => p.accountId), ['z', 'a']); // Swedish: Ä after Z
  const s = state({ settings: { stalePeople: people, staleSort: 'oldest' } });
  assert.deepEqual(compute(s, ui(), { locale: 'sv-SE' }).stale.people.map(p => p.accountId), ['z', 'a']);
  assert.deepEqual(compute(s, ui()).stale.people.map(p => p.accountId), ['a', 'z']); // English by default
});

test('stale: oldest first, or newest first', () => {
  const issues = [staleIssue('S-2', 200), staleIssue('S-3', 300), staleIssue('S-1', 100)];
  const oldest = compute(state({ stale: { issues }, settings: { stalePeople: [], staleSort: 'oldest' } }), ui());
  const newest = compute(state({ stale: { issues }, settings: { stalePeople: [], staleSort: 'newest' } }), ui());
  assert.deepEqual(keysOf(oldest.stale.issues), ['S-1', 'S-2', 'S-3']);
  assert.deepEqual(keysOf(newest.stale.issues), ['S-3', 'S-2', 'S-1']);
});

test('stale: the filter keeps only the chosen people; no filter is everyone', () => {
  const issues = [staleIssue('S-1', 100, ME), staleIssue('S-2', 200, SAM), staleIssue('S-3', 300, null)];
  const settings = { stalePeople: [ME, SAM], staleSort: 'oldest' };
  const all = compute(state({ stale: { issues }, settings }), ui());
  assert.deepEqual(keysOf(all.stale.issues), ['S-1', 'S-2', 'S-3']);
  const sam = compute(state({ stale: { issues }, settings }), ui({ staleFilter: ['sam'] }));
  assert.deepEqual(sam.stale.filter, ['sam']);
  assert.deepEqual(keysOf(sam.stale.issues), ['S-2']);
});

test('stale: the filter ignores people who are no longer in the setting', () => {
  const issues = [staleIssue('S-1', 100, ME), staleIssue('S-2', 200, SAM)];
  const settings = { stalePeople: [ME], staleSort: 'oldest' };
  const c = compute(state({ stale: { issues }, settings }), ui({ staleFilter: ['sam'] }));
  assert.deepEqual(c.stale.filter, []);
  assert.deepEqual(keysOf(c.stale.issues), ['S-1', 'S-2']); // no valid filter left, so nothing filtered out
});

test('stale: compute does not modify its input', () => {
  const issues = [staleIssue('S-2', 200), staleIssue('S-1', 100)];
  compute(state({ stale: { issues } }), ui({ view: 'stale' }));
  assert.deepEqual(keysOf(issues), ['S-2', 'S-1']);
});

test('stale: Unassigned is a group of its own once the setting is on', () => {
  const issues = [staleIssue('S-1', 100, ME), staleIssue('S-2', 200, SAM), staleIssue('S-3', 300, null)];
  const settings = { stalePeople: [ME, SAM], staleUnassigned: true, staleSort: 'oldest' };
  const all = compute(state({ stale: { issues }, settings }), ui());
  assert.equal(all.stale.unassigned, true);
  assert.deepEqual(keysOf(all.stale.issues), ['S-1', 'S-2', 'S-3']);
  const nobody = compute(state({ stale: { issues }, settings }), ui({ staleFilter: [UNASSIGNED] }));
  assert.deepEqual(nobody.stale.filter, [UNASSIGNED]);
  assert.deepEqual(keysOf(nobody.stale.issues), ['S-3']);
  const both = compute(state({ stale: { issues }, settings }), ui({ staleFilter: ['sam', UNASSIGNED] }));
  assert.deepEqual(keysOf(both.stale.issues), ['S-2', 'S-3']);
});

test('stale: with the setting off, Unassigned in the filter is ignored like an unticked person', () => {
  const issues = [staleIssue('S-1', 100, ME), staleIssue('S-2', 200, SAM), staleIssue('S-3', 300, null)];
  const settings = { stalePeople: [ME, SAM], staleSort: 'oldest' };
  const c = compute(state({ stale: { issues }, settings }), ui({ staleFilter: [UNASSIGNED, 'sam'] }));
  assert.equal(c.stale.unassigned, false);
  assert.deepEqual(c.stale.filter, ['sam']);
  assert.deepEqual(keysOf(c.stale.issues), ['S-2']);
});

/* ---------- counts ---------- */

test('counts: stale follows the person filter, notes without ticked-off ones', () => {
  const issues = [staleIssue('S-1', 100, ME), staleIssue('S-2', 200, SAM), staleIssue('S-3', 300, SAM)];
  const notes = [{ id: 1, done: false }, { id: 2, done: true }, { id: 3 }];
  const s = state({
    tracked: [tr('A-1', { changes: [ch(1)] }), tr('A-2'), loadingTr('A-3')],
    stale: { issues }, notes, settings: { stalePeople: [ME, SAM], staleSort: 'oldest' },
  });
  const c = compute(s, ui({ staleFilter: ['sam'] }));
  assert.deepEqual(c.counts, { changed: 1, tracked: 3, stale: 2, notes: 2 });
  assert.equal(c.stale.issues.length, 2);
  assert.equal(compute(s, ui({ staleFilter: [] })).counts.stale, 3); // no filter: everyone
});

/* ---------- keys and shown ---------- */

test('keys: the navigable keys per view', () => {
  const s = state({
    tracked: [tr('A-1', { changes: [ch(5)] }), tr('A-2', { updated: 200 }), tr('A-3', { updated: 100 })],
    stale: { issues: [staleIssue('S-2', 200), staleIssue('S-1', 100)] },
  });
  assert.deepEqual(compute(s, ui({ view: 'changed' })).keys, ['A-1']);
  assert.deepEqual(compute(s, ui({ view: 'tracked' })).keys, ['A-1', 'A-2', 'A-3']);
  assert.deepEqual(compute(s, ui({ view: 'stale' })).keys, ['S-1', 'S-2']);
  assert.deepEqual(compute(s, ui({ view: 'settings' })).keys, []);
  assert.deepEqual(compute(s, ui({ view: 'notes' })).keys, []);
});

test('keys: a collapsed Done group is skipped, an open group is not', () => {
  const s = state({ tracked: [tr('A-1'), tr('D-1', { cat: 'done' })] });
  assert.deepEqual(compute(s, ui({ view: 'tracked' })).keys, ['A-1']);
  assert.deepEqual(compute(s, ui({ view: 'tracked', doneOpen: true })).keys, ['A-1', 'D-1']);
});

test('shown: a key in the list, or held in the collapsed Done group', () => {
  const s = state({ tracked: [tr('A-1'), tr('D-1', { cat: 'done' }), tr('A-9', { changes: [ch(1)] })] });
  const c = compute(s, ui({ view: 'tracked' }));
  assert.equal(c.shown('A-1'), true);
  assert.equal(c.shown('D-1'), true); // held
  assert.equal(c.shown('Z-1'), false);
  assert.equal(c.shown(null), false);
  const changed = compute(s, ui({ view: 'changed' }));
  assert.equal(changed.shown('A-9'), true);
  assert.equal(changed.shown('D-1'), false); // held only applies in Tracked
});

test('shown: an issue filtered out is not visible', () => {
  const s = state({ tracked: six([tr('X-1', { summary: 'Keyword' })]) });
  const c = compute(s, ui({ view: 'tracked', trackedQuery: 'keyword' }));
  assert.equal(c.shown('X-1'), true);
  assert.equal(c.shown('A-1'), false);
});

/* ---------- settle ---------- */

test('settle: a visible pendingSelect is selected, highlighted, revealed and cleared', () => {
  const s = state({ tracked: [tr('A-1'), tr('A-2')] });
  const patch = settle(s, ui({ view: 'tracked', selected: 'A-1', pendingSelect: 'A-2' }), { wide: true });
  assert.deepEqual(patch, { selected: 'A-2', highlight: 'A-2', reveal: 'A-2', pendingSelect: null });
});

test('settle: pendingSelect on a done issue opens the Done group', () => {
  const s = state({ tracked: [tr('A-1'), tr('D-1', { cat: 'done' })] });
  const patch = settle(s, ui({ view: 'tracked', selected: 'A-1', pendingSelect: 'D-1' }), { wide: true });
  assert.deepEqual(patch, { selected: 'D-1', highlight: 'D-1', reveal: 'D-1', pendingSelect: null, doneOpen: true });
});

test('settle: pendingSelect waits until the issue is in the state and loaded', () => {
  const s = state({ tracked: [tr('A-1'), loadingTr('A-2')] });
  assert.deepEqual(settle(s, ui({ view: 'tracked', selected: 'A-1', pendingSelect: 'A-2' }), { wide: true }), {});
  assert.deepEqual(settle(s, ui({ view: 'tracked', selected: 'A-1', pendingSelect: 'A-3' }), { wide: true }), {});
});

test('settle: a pendingSelect not in the current view keeps waiting', () => {
  const s = state({ tracked: [tr('A-1', { changes: [ch(1)] }), tr('A-2')] });
  const patch = settle(s, ui({ view: 'changed', selected: 'A-1', pendingSelect: 'A-2' }), { wide: true });
  assert.deepEqual(patch, {});
});

test('settle: an invalid selection becomes the first key (wide) or null (narrow)', () => {
  const s = state({ tracked: [tr('A-1', { updated: 200 }), tr('A-2', { updated: 100 })] });
  const v = ui({ view: 'tracked', selected: 'GONE-1' });
  assert.deepEqual(settle(s, v, { wide: true }), { selected: 'A-1' });
  assert.deepEqual(settle(s, v, { wide: false }), { selected: null });
  assert.deepEqual(settle(s, ui({ view: 'tracked', selected: null }), { wide: true }), { selected: 'A-1' });
});

test('settle: an empty list gives null, and a valid selection changes nothing', () => {
  assert.deepEqual(settle(state(), ui({ view: 'changed', selected: 'A-1' }), { wide: true }), { selected: null });
  const s = state({ tracked: [tr('A-1'), tr('A-2')] });
  assert.deepEqual(settle(s, ui({ view: 'tracked', selected: 'A-2' }), { wide: true }), {});
  assert.deepEqual(settle(s, ui({ view: 'tracked', selected: null }), { wide: false }), {});
});

test('settle: a selection in the collapsed Done group stays (held)', () => {
  const s = state({ tracked: [tr('A-1'), tr('D-1', { cat: 'done' })] });
  assert.deepEqual(settle(s, ui({ view: 'tracked', selected: 'D-1', doneOpen: false }), { wide: true }), {});
});

test('settle: a selection filtered out becomes the first key', () => {
  const s = state({ tracked: six([tr('X-1', { summary: 'Keyword' })]) });
  const patch = settle(s, ui({ view: 'tracked', selected: 'A-1', trackedQuery: 'keyword' }), { wide: true });
  assert.deepEqual(patch, { selected: 'X-1' });
});

test('settle: on pages without a list the selection is left alone', () => {
  const s = state({ tracked: [tr('A-1')] });
  assert.deepEqual(settle(s, ui({ view: 'settings', selected: null }), { wide: true }), {});
  assert.deepEqual(settle(s, ui({ view: 'notes', selected: 'GONE-1' }), { wide: true }), {});
});

test('settle: in Stale it also selects the first key of the sorted list', () => {
  const s = state({ stale: { issues: [staleIssue('S-2', 200), staleIssue('S-1', 100)] } });
  assert.deepEqual(settle(s, ui({ view: 'stale' }), { wide: true }), { selected: 'S-1' });
});

test('settle: does not modify its input', () => {
  const v = ui({ view: 'tracked', selected: 'GONE-1', pendingSelect: 'A-1' });
  const before = JSON.stringify(v);
  settle(state({ tracked: [tr('A-1')] }), v, { wide: true });
  assert.equal(JSON.stringify(v), before);
});

/* ---------- neighbour ---------- */

test('neighbour: the next, otherwise the previous, otherwise null', () => {
  assert.equal(neighbour(['a', 'b', 'c'], 'a'), 'b');
  assert.equal(neighbour(['a', 'b', 'c'], 'b'), 'c');
  assert.equal(neighbour(['a', 'b', 'c'], 'c'), 'b');
  assert.equal(neighbour(['a'], 'a'), null);
  assert.equal(neighbour([], 'a'), null);
});
