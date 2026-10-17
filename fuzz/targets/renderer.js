'use strict';
/* renderer/app.js: the whole window's HTML (draw()) for random states, with Jira text that tries to break out of it. */

const fs = require('node:fs');
const path = require('node:path');
const { normalizeIssue, changesFromChangelog, changesFromComments } = require('../../src/main/changes');
const { DEFAULT_SETTINGS } = require('../../src/main/tracker');
const { LANGUAGE_SETTINGS } = require('../../src/shared/i18n');
const { loadRenderer } = require('../lib/renderer');
const { fail } = require('../lib/property');

const APP = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'app.js'), 'utf8');
// Every tag and attribute app.js writes itself; anything else in the output came from data.
const TAGS = new Set([...APP.matchAll(/<\/?([a-z][a-z0-9-]*)/g)].map(m => m[1]));
const ATTRS = new Set([...APP.matchAll(/<[a-z][^<>]*>/g)].flatMap(tag => [...tag[0].matchAll(/\s([a-zA-Z][\w-]*)(?=[\s=/>]|$)/g)].map(m => m[1].toLowerCase()))
  .concat(['disabled', 'checked', 'selected', 'readonly', 'hidden', 'open', 'required'])); // written through ${cond ? 'checked' : ''}
if ([...ATTRS].some(a => a.startsWith('onx'))) throw new Error('fuzz/targets/renderer.js: the attribute allowlist contains a payload name');

const PAYLOADS = ['<x-evil>', '</div><x-evil a=1>', '" onx="1', "' onx='1", '<img src=x onx=1>', '&lt;x-evil&gt;', '${x}', '{who}', '<!--', '<svg/onx=1>'];

/** Jira text for this case: hostile (markup that tries to escape) or clean (no markup, but emoji, accents and odd spacing). */
function textGen(r, hostile) {
  const clean = () => r.weighted([
    [5, () => r.plainText(4)],
    [1, () => r.pick(['😀 Smith', '👩‍💻 Dev', 'Ünal Öz', 'éclair', '  ', ' Lee ', '日本 太郎', 'Ana-María', 'x'.repeat(40) + '😀'.repeat(10)])],
    [1, () => `${r.plainText(3)} ${'😀'.repeat(r.int(1, 30))}`],
  ]);
  return () => (hostile && r.bool(0.4) ? `${r.text(3)}${r.pick(PAYLOADS)}${r.text(2)}` : clean());
}

function genCase(r, hostile) {
  const s = textGen(r, hostile);
  const date = () => new Date(1_790_000_000_000 - r.int(0, 90) * 86_400_000).toISOString().replace('Z', '+0000');
  const person = () => (r.bool(0.2) ? null : { accountId: r.pick(['acc-me', 'acc-alex', 'acc-sam']), displayName: s() });
  const doc = () => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: s() || 'x' }, ...(r.bool(0.3) ? [{ type: 'mention', attrs: { id: 'acc-me', text: `@${s()}` } }] : [])] }] });
  const related = () => ({ key: `WEB-${r.int(1, 99)}`, fields: { summary: s(), status: { name: s(), statusCategory: { key: r.pick(['new', 'indeterminate', 'done']) } } } });
  const rawIssue = key => ({
    id: String(r.int(10_000, 99_999)), key,
    fields: {
      summary: s(), status: { name: s(), statusCategory: { key: r.pick(['new', 'indeterminate', 'done']) } }, issuetype: { name: s(), subtask: r.bool(0.1) },
      priority: r.bool(0.8) ? { name: r.pick(['High', 'Low', s()]) } : null, assignee: person(), updated: date(),
      labels: r.array(s, 0, 3), fixVersions: r.array(() => ({ name: s() }), 0, 2), project: { key: key.split('-')[0], name: s() },
      parent: r.bool(0.3) ? related() : null, subtasks: r.array(related, 0, 2),
      issuelinks: r.array(() => ({ type: { name: s(), inward: s(), outward: s() }, [r.pick(['inwardIssue', 'outwardIssue'])]: related() }), 0, 2),
      description: r.bool(0.6) ? doc() : null,
    },
  });
  const FIELDS = ['status', 'assignee', 'priority', 'summary', 'description', 'labels', 'Fix Version', 'Attachment', 'Sprint', 'duedate', 'Key', s()];
  const changesOf = () => {
    const histories = r.array(() => ({ id: String(r.int(1, 1e6)), created: date(), author: person(), items: r.array(() => ({ field: r.pick(FIELDS), fromString: r.bool(0.7) ? s() : null, toString: r.bool(0.8) ? s() : null }), 1, 2) }), 0, 3);
    const comments = r.array(() => ({ id: String(r.int(1, 1e6)), created: date(), updated: date(), author: person(), body: doc() }), 0, 3);
    const out = [...changesFromChangelog(histories, null), ...changesFromComments(comments, null)];
    if (r.bool(0.2)) out.push({ id: `c${r.int(1, 1e6)}@1`, at: Date.now() - 5000, author: person() && { accountId: 'acc-sam', name: s() }, field: 'comment', label: 'Comment', edited: true, from: s(), to: s() });
    if (r.bool(0.1)) out.push({ id: `gone-1-${r.int(1, 1e6)}`, at: Date.now(), author: null, field: 'gone', label: null, from: null, to: null });
    if (r.bool(0.2)) out.push({ id: `s${r.int(1, 1e6)}-assignee`, at: Date.now() - 1000, author: null, field: 'assignee', label: 'assignee', from: s(), to: r.pick(['Demo User', s()]) });
    return out.map(c => {
      const processed = r.bool(0.4);
      const rec = { ...c, processed, processedAt: processed ? Date.now() - 1000 : null, ...(r.bool(0.1) && { own: true }) };
      if (c.field === 'comment' && c.mentions?.some(m => m.accountId === 'acc-me')) rec.mentionsMe = true;
      return rec;
    });
  };
  const keys = [...new Set(r.array(() => `${r.pick(['WEB', 'OPS', 'APP'])}-${r.int(1, 99)}`, 0, 8))];
  const tracked = keys.map(key => {
    if (r.bool(0.05)) return { key, addedAt: Date.now(), loading: true, changes: [] };
    const issue = r.bool(0.95) ? normalizeIssue(rawIssue(key)) : undefined;
    return { key, id: issue?.id, issue, addedAt: Date.now() - r.int(0, 9e8), lastChecked: r.bool(0.9) ? Date.now() - r.int(0, 9e5) : null, seenUntil: issue?.updated, error: r.bool(0.1) ? s() : null, changes: changesOf() };
  });
  const staleKeys = [...new Set(r.array(() => `OPS-${r.int(100, 199)}`, 0, 5))];
  const people = r.array(() => ({ accountId: r.pick(['acc-me', 'acc-alex', 'acc-sam', 'acc-jo']), name: s() }), 0, 4);
  const notes = r.array(i => ({ id: `n${i}`, text: (s() || 'x').slice(0, 255), createdAt: Date.now() - r.int(0, 9e8), ...(r.bool(0.2) && { done: true, doneAt: Date.now() }) }), 0, 4);
  const settings = {
    ...DEFAULT_SETTINGS, baseUrl: 'https://acme.atlassian.net', email: 'me@example.com', hasToken: r.bool(0.9),
    defaultProject: r.pick(['', 'WEB']), notesProject: r.pick(['', 'OPS']), staleDays: r.int(1, 365), staleSort: r.pick(['oldest', 'newest']),
    stalePeople: r.bool(0.5) ? people : [], staleUnassigned: r.bool(), excluded: r.array(s, 0, 2), excludedProjects: r.array(s, 0, 2),
    language: r.pick(LANGUAGE_SETTINGS), theme: r.pick(['system', 'light', 'dark']),
  };
  const state = {
    settings, me: r.bool(0.9) ? { accountId: 'acc-me', name: r.pick(['Demo User', s()]) } : null, tracked,
    stale: { issues: staleKeys.map(k => normalizeIssue(rawIssue(k))), fetchedAt: r.bool(0.8) ? Date.now() - 60_000 : null, truncated: r.bool(0.1), error: r.bool(0.1) ? s() : null, warning: r.bool(0.1) ? s() : null },
    notes,
    people: { list: people, fetchedAt: Date.now(), loading: r.bool(0.1), error: r.bool(0.1) ? s() : null },
    status: { state: r.pick(['idle', 'checking', 'ok', 'error', 'unconfigured']), message: s(), lastCheck: Date.now() - 60_000, nextCheck: Date.now() + 60_000 },
    notifications: r.pick([null, { ok: true, at: Date.now() }, { ok: false, error: s(), at: Date.now() }, { ok: null, at: Date.now() }]),
    env: { platform: 'darwin', packaged: r.bool(), locale: r.pick(['en-US', 'en-GB', 'nl-NL', 'de-DE', 'fr-FR', 'es-ES', 'it-IT']) },
    version: '0.2.0',
    updates: { lastCheck: null, latest: r.pick([null, '0.3.0']), url: null, dismissed: null, newer: r.bool(0.2) },
  };
  const allKeys = [...keys, ...staleKeys];
  const activity = {};
  for (const k of allKeys) {
    if (r.bool(0.5)) activity[k] = r.pick([
      { ok: false, error: s(), fetchedAt: 1 },
      { ok: true, comment: r.bool() ? { author: { accountId: 'acc-sam', name: s() }, at: Date.now() - 9e5, text: s() } : null, change: r.bool() ? { author: { accountId: 'acc-alex', name: s() }, at: Date.now(), field: r.pick(['status', 'other', 'priority']), label: s(), from: s(), to: s() } : null, fetchedAt: 2 },
    ]);
  }
  const ui = {
    view: r.pick(['changed', 'tracked', 'stale', 'notes', 'settings', 'connect']),
    selected: allKeys.length && r.bool(0.8) ? r.pick(allKeys) : null,
    detailOpen: r.bool(), doneOpen: r.bool(), trackedQuery: r.bool(0.2) ? s() : '', staleMenu: r.bool(), help: r.bool(0.1),
    addText: r.bool(0.2) ? s() : '', staleFilter: r.bool(0.3) ? people.map(p => p.accountId) : [], activity,
    conn: r.pick([null, 'busy', { ok: r.bool(), message: s() }]),
    draft: notes.length && r.bool(0.4) ? {
      id: notes[0].id, summary: s(), project: s(), typeId: '1', types: r.array(i => ({ id: String(i), name: s() }), 0, 3),
      typesState: r.pick(['loading', 'ready', 'error']), typesError: s(), error: r.bool(0.3) ? s() : null, creating: r.bool(0.1),
    } : null,
  };
  return { state, ui };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
const visibleText = html => html.replace(/<[^>]*>/g, ' ').replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ENTITIES[e]);

/** Checks the HTML: only tags and attributes app.js writes itself, and no stray "<" (text that was not escaped).
 *  A "<" before anything but a letter, /, ! or ? is text to an HTML parser (the French "< 1 min"), so only those count. */
function checkMarkup(html) {
  const opens = text => /<[a-zA-Z/!?]/.exec(text);
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*)\s*\/?>/g;
  let last = 0;
  for (const m of html.matchAll(tagRe)) {
    const between = html.slice(last, m.index);
    const stray = opens(between);
    if (stray) fail('stray-lt', 'a "<" in the output that does not start a tag: unescaped text', { around: html.slice(Math.max(0, last + stray.index - 80), last + stray.index + 80) });
    last = m.index + m[0].length;
    const [, , name, attrs] = m;
    if (!TAGS.has(name.toLowerCase())) fail('foreign-tag', `a <${name}> tag that app.js never writes: Jira text became markup`, { tag: m[0] });
    for (const a of attrs.matchAll(/\s+([^\s=>/]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?/g)) {
      if (!ATTRS.has(a[1].toLowerCase())) fail('foreign-attribute', `an attribute "${a[1]}" that app.js never writes: Jira text broke out of a quoted value`, { tag: m[0] });
    }
  }
  if (opens(html.slice(last))) fail('stray-lt', 'a "<" after the last tag: unescaped text', { tail: html.slice(last, last + 160) });
}

let draw = null;
const render = ({ state, ui }) => {
  draw ||= loadRenderer().draw;
  return draw(structuredClone(state), structuredClone(ui));
};

const properties = [
  {
    name: 'renderer.escape',
    description: 'However Jira text is crafted, the window HTML only holds the tags and attributes app.js writes: no text becomes markup.',
    runs: 1500,
    noShrink: true, // the state is large and its parts depend on each other; the details name the offending tag
    gen: r => genCase(r, true),
    check(input) { checkMarkup(render(input)); },
    show: input => `(state with ${input.state.tracked.length} tracked, view ${input.ui.view}; replay to inspect)`,
  },
  {
    name: 'renderer.text',
    description: 'The visible text never shows "undefined", "NaN", "[object Object]" or "Invalid Date", and never splits an emoji into a broken character.',
    runs: 1500,
    noShrink: true,
    gen: r => genCase(r, false),
    check(input) {
      const text = visibleText(render(input));
      const bad = /\bundefined\b|\bNaN\b|\[object Object\]|Invalid Date/.exec(text);
      if (bad) fail('junk-text', `the window shows "${bad[0]}"`, { around: text.slice(Math.max(0, bad.index - 120), bad.index + 60).replace(/\s+/g, ' ') });
      const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.exec(text);
      if (lone) fail('broken-emoji', 'the window shows half of an emoji (a lone UTF-16 surrogate)', { around: JSON.stringify(text.slice(Math.max(0, lone.index - 40), lone.index + 10).replace(/\s+/g, ' ')) });
    },
    show: input => `(state with ${input.state.tracked.length} tracked, view ${input.ui.view}; replay to inspect)`,
  },
];

module.exports = { properties };
