'use strict';
/* shared/inbox.js (lists and selection) and shared/change.js (importance order, the wording of a change). */

const { compute, settle, isDone, isChanged } = require('../../src/shared/inbox');
const { compareChanges, rankChanges, describe, shortLine, chip } = require('../../src/shared/change');
const { createTranslator, LANGUAGES } = require('../../src/shared/i18n');
const { fail } = require('../lib/property');

const LIST_VIEWS = ['changed', 'tracked', 'stale'];

function genInbox(r) {
  const keys = [...new Set(r.array(() => `${r.pick(['WEB', 'OPS'])}-${r.int(1, 30)}`, 0, 10))];
  const tracked = keys.map(key => {
    if (r.bool(0.05)) return { key, loading: true, changes: [] };
    const hasIssue = r.bool(0.95);
    return {
      key, id: key,
      issue: hasIssue ? { key, summary: r.pick(['Checkout broken', 'Café menu', 'Login', '']), status: r.pick(['To Do', 'Done', 'In Progress']), statusCat: r.pick(['new', 'indeterminate', 'done']), updated: r.int(0, 50), assignee: r.bool(0.7) ? { accountId: 'a', name: r.pick(['Sam', 'Zoë']) } : null } : undefined,
      error: r.bool(0.1) ? 'Not found' : null,
      changes: r.array(i => ({ id: `c${i}`, at: r.int(0, 50), processed: r.bool(0.5) }), 0, 4),
    };
  });
  const staleIssues = [...new Set(r.array(() => `APP-${r.int(1, 30)}`, 0, 6))].map(key => ({ key, updated: r.int(0, 50), assignee: r.bool(0.7) ? { accountId: r.pick(['me', 'sam']) } : null }));
  const me = r.bool(0.9) ? { accountId: 'me', name: 'Me' } : null;
  const state = {
    tracked, me, notes: r.array(() => ({ done: r.bool() }), 0, 3),
    stale: { issues: staleIssues },
    settings: { stalePeople: r.bool() ? [{ accountId: 'sam', name: 'Sam' }, ...(r.bool() ? [{ accountId: 'me', name: 'Me' }] : [])] : [], staleUnassigned: r.bool(), staleSort: r.pick(['oldest', 'newest']) },
  };
  const candidates = [...keys, ...staleIssues.map(i => i.key), 'NOPE-1', null];
  const ui = {
    view: r.pick([...LIST_VIEWS, 'notes', 'settings']),
    selected: r.pick(candidates), pendingSelect: r.bool(0.3) ? r.pick(candidates) : null,
    doneOpen: r.bool(), trackedQuery: r.pick(['', '', 'web', 'cafe', 'CAFÉ', 'sam', 'zz', ' ']),
    staleFilter: r.bool(0.4) ? r.array(() => r.pick(['me', 'sam', 'unassigned', 'gone']), 1, 2) : [],
  };
  return { state, ui, wide: r.bool(0.7) };
}

const TEXT_SAFE = /\bundefined\b|\bnull\b|\bNaN\b|\[object Object\]|\{\w+\}/;

function genChange(r) {
  const field = r.pick(['status', 'assignee', 'priority', 'summary', 'description', 'labels', 'fixVersion', 'attachment', 'comment', 'gone', 'other', 'sprint', 'duedate', 'key']);
  const value = () => r.weighted([[3, () => r.plainText(3)], [1, null], [1, ''], [1, 'Demo User'], [1, () => 'x'.repeat(r.int(20, 200))]]);
  return {
    id: r.pick(['c1', 'c2@5', 'h1-0', 'h2-1', 's9-status', 'gone-1-2']), at: r.pick([0, 1, 2, 1000, undefined]),
    author: r.pick([null, { accountId: 'a', name: 'Sam Rivera' }, { accountId: 'b', name: '' }, { accountId: 'c', name: '  ' }, { accountId: 'd', name: null }]),
    field, label: field === 'other' ? r.pick(['Story Points', 'Team', '']) : field, from: value(), to: value(),
    ...(field === 'comment' && r.bool(0.3) && { edited: true }), ...(r.bool(0.2) && { mentionsMe: true }), ...(r.bool(0.1) && { risk: true }),
  };
}

const sign = n => (n > 0 ? 1 : n < 0 ? -1 : 0);

const properties = [
  {
    name: 'inbox.settle',
    description: 'settle() reaches a fixed point in one step, and in a list view the selection is visible (wide: the first key when there is one).',
    runs: 4000,
    gen: genInbox,
    check({ state, ui, wide }) {
      const patch = settle(state, ui, { wide, locale: 'en' });
      const next = { ...ui, ...patch };
      const again = settle(state, next, { wide, locale: 'en' });
      if (Object.keys(again).length) fail('not-settled', 'a second settle() still changes the UI state', { patch, again });
      if (!LIST_VIEWS.includes(next.view)) return;
      const c = compute(state, next, { locale: 'en' });
      if (next.selected != null && !c.shown(next.selected)) fail('hidden-selection', `the selected ${next.selected} is not in the list`, { keys: c.keys });
      if (wide && c.keys.length && next.selected == null) fail('wide-no-selection', 'a wide window with a non-empty list selects nothing', { keys: c.keys });
    },
  },
  {
    name: 'inbox.partition',
    description: 'Every tracked issue (matching the filter) is in exactly one place: Changed+active or Done; keys never repeat; counts match the lists.',
    runs: 4000,
    gen: genInbox,
    check({ state, ui }) {
      const c = compute(state, { ...ui, view: 'tracked', doneOpen: true }, { locale: 'en' });
      const listed = [...c.tracked.active, ...c.tracked.done].map(t => t.key);
      if (new Set(listed).size !== listed.length) fail('listed-twice', `an issue is listed twice: ${listed}`);
      if (!c.tracked.query && listed.length !== state.tracked.length) fail('issue-missing', `${state.tracked.length} tracked but ${listed.length} listed`, { listed });
      if (c.tracked.done.some(t => !isDone(t))) fail('done-not-done', 'the Done group holds an issue that is not done');
      if (c.counts.changed !== state.tracked.filter(isChanged).length) fail('changed-count', 'the Changed count differs from the changed issues');
      if (new Set(c.keys).size !== c.keys.length) fail('duplicate-keys', 'j/k keys repeat', { keys: c.keys });
    },
  },
  {
    name: 'change.order',
    description: 'compareChanges is a consistent order (antisymmetric, transitive), so rankChanges picks the same lead whatever the input order.',
    runs: 5000,
    gen: r => ({ list: r.array(() => genChange(r), 3, 6), me: r.pick(['Demo User', '', null]) }),
    check({ list, me }) {
      const [a, b, c] = list;
      const cmp = (x, y) => compareChanges(x, y, me);
      if (sign(cmp(a, b)) !== -sign(cmp(b, a))) fail('not-antisymmetric', 'compare(a, b) and compare(b, a) disagree', { a, b });
      if (cmp(a, b) <= 0 && cmp(b, c) <= 0 && cmp(a, c) > 0) fail('not-transitive', 'a ≤ b and b ≤ c, but a > c', { a, b, c });
      const lead = rankChanges(list, me)[0];
      const leadReversed = rankChanges([...list].reverse(), me)[0];
      if (cmp(lead, leadReversed) !== 0) fail('lead-depends-on-order', 'the lead change depends on the input order', { lead, leadReversed });
    },
  },
  {
    name: 'change.words',
    description: 'describe(), shortLine() and chip() never throw and never show "undefined", "null", "NaN" or an unfilled {placeholder}, in every language.',
    runs: 4000,
    gen: r => ({ change: genChange(r), me: r.pick(['Demo User', 'Sam Rivera', null]), language: r.pick(LANGUAGES), authorIsMe: r.bool(0.2) }),
    check({ change, me, language, authorIsMe }) {
      const t = createTranslator(language);
      const texts = {
        describe: describe(change, { me, key: 'WEB-1', t }),
        shortLine: shortLine(change, { me, authorIsMe, t }),
        chip: chip(change, { me, t }).text,
      };
      for (const [fn, text] of Object.entries(texts)) {
        if (typeof text !== 'string' || !text.trim()) fail('empty-text', `${fn}() gives no text`, { change, language });
        const bad = TEXT_SAFE.exec(text);
        if (bad) fail('junk-text', `${fn}() in ${language} shows "${bad[0]}": ${JSON.stringify(text)}`, { change });
      }
    },
  },
];

module.exports = { properties };
