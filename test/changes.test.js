'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ISSUE_FIELDS, parseJiraDate, normalizeIssue, changesFromChangelog, changesFromComments, changesFromSnapshots, adfToText, staleJql, unknownStatuses, excludedProject,
} = require('../src/main/changes');
const { jqlList } = require('./support/mock-jira');

test('parseJiraDate understands Jira offsets without a colon', () => {
  assert.equal(parseJiraDate('2026-10-09T13:02:11.123+0200'), Date.UTC(2026, 9, 9, 11, 2, 11, 123));
  assert.equal(parseJiraDate('2026-10-09T11:02:11.123Z'), Date.UTC(2026, 9, 9, 11, 2, 11, 123));
  assert.equal(parseJiraDate(null), null);
  assert.equal(parseJiraDate('onzin'), null);
});

test('normalizeIssue makes a flat issue', () => {
  const i = normalizeIssue({
    id: 10001,
    key: 'WEB-1',
    fields: {
      summary: 'Title',
      status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
      issuetype: { name: 'Bug', subtask: false },
      priority: { name: 'High' },
      assignee: { accountId: 'a1', displayName: 'Sam Rivera' },
      updated: '2026-10-09T10:00:00.000+0000',
      labels: ['x'],
      fixVersions: [{ name: '2026.10' }],
      project: { key: 'WEB', name: 'Website' },
    },
  });
  assert.deepEqual(i, {
    id: '10001', key: 'WEB-1', summary: 'Title', status: 'In Progress', statusCat: 'indeterminate', type: 'Bug', subtask: false,
    priority: 'High', assignee: { accountId: 'a1', name: 'Sam Rivera' }, updated: Date.UTC(2026, 9, 9, 10), labels: ['x'],
    fixVersions: ['2026.10'], parent: null, subtasks: [], links: [], project: 'Website', projectKey: 'WEB', description: '',
  });
});

test('normalizeIssue reads standard relations, directional links and partial data', () => {
  for (const field of ['parent', 'subtasks', 'issuelinks']) assert.ok(ISSUE_FIELDS.includes(field));
  const related = { id: '2', key: 'WEB-2', fields: { summary: 'Parent', status: { name: 'Closed', statusCategory: { key: 'done' } } } };
  const expected = { key: 'WEB-2', summary: 'Parent', status: 'Closed', statusCat: 'done' };
  const i = normalizeIssue({ fields: {
    parent: related,
    subtasks: [related, null, {}, { key: 'WEB-3' }],
    issuelinks: [
      { type: { inward: 'is blocked by', outward: 'blocks' }, inwardIssue: related },
      { type: { inward: 'is blocked by', outward: 'blocks' }, outwardIssue: { key: 'WEB-3' } },
      null, {}, { type: {}, inwardIssue: {} },
    ],
  } });
  assert.deepEqual(i.parent, expected);
  const partial = { key: 'WEB-3', summary: '', status: null, statusCat: 'new' };
  assert.deepEqual(i.subtasks, [expected, partial]);
  assert.deepEqual(i.links, [{ type: 'is blocked by', issue: expected }, { type: 'blocks', issue: partial }]);
  const empty = normalizeIssue({ fields: { parent: {}, subtasks: null, issuelinks: null, fixVersions: [null, {}, { name: '1.0' }], labels: [null, 'mobile'] } });
  assert.equal(empty.parent, null);
  assert.deepEqual(empty.subtasks, []);
  assert.deepEqual(empty.links, []);
  assert.deepEqual(empty.fixVersions, ['1.0']);
  assert.deepEqual(empty.labels, ['mobile']);
  assert.deepEqual(normalizeIssue({}).links, []);
});

test('normalizeIssue converts an ADF description to text and truncates at 2000 characters', () => {
  const adf = text => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
  assert.equal(normalizeIssue({ id: 1, key: 'WEB-1', fields: { description: adf('First line') } }).description, 'First line');
  assert.equal(normalizeIssue({ id: 1, key: 'WEB-1', fields: { description: adf('x'.repeat(2500)) } }).description.length, 2000);
  const cut = normalizeIssue({ id: 1, key: 'WEB-1', fields: { description: adf(`${'x'.repeat(1999)}🚀`) } }).description;
  assert.equal(cut, 'x'.repeat(1999)); // an emoji at the cut stays out whole
  assert.equal(normalizeIssue({ id: 1, key: 'WEB-1', fields: {} }).description, '');
  assert.equal(normalizeIssue({ id: 1, key: 'WEB-1', fields: { description: null } }).description, '');
});

test('normalizeIssue: a missing status, type or display name becomes null, so the UI words it', () => {
  const i = normalizeIssue({ id: 1, key: 'WEB-1', fields: { assignee: { accountId: 'a1' } } });
  assert.equal(i.status, null);
  assert.equal(i.type, null);
  assert.deepEqual(i.assignee, { accountId: 'a1', name: null });
  assert.equal(normalizeIssue({ id: 1, key: 'WEB-1', fields: { assignee: null } }).assignee, null); // unassigned
});

test('adfToText: attachments and nameless mentions become neutral markers', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'See ' }, { type: 'mention', attrs: { id: 'x' } }] },
      { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'm1' } }] },
    ],
  };
  assert.equal(adfToText(doc), 'See @someone\n\n[attachment]');
});

test('changes without an author name keep the author with a null name', () => {
  const [c] = changesFromChangelog([{ id: '9', author: { accountId: 'a9' }, created: '2026-10-01T10:00:00.000+0000', items: [{ field: 'status', fromString: 'A', toString: 'B' }] }], null);
  assert.deepEqual(c.author, { accountId: 'a9', name: null });
});

const author = { accountId: 'a1', displayName: 'Alex' };
const histories = [
  { id: '1', author, created: '2026-10-01T10:00:00.000+0000', items: [{ field: 'status', fromString: 'To Do', toString: 'In Progress' }] },
  {
    id: '2', author, created: '2026-10-02T10:00:00.000+0000',
    items: [
      { field: 'Rank', fromString: '', toString: 'Ranked higher' },
      { field: 'Fix Version', fromString: null, toString: '2026.10' },
      { field: 'Story Points', fromString: '3', toString: '5' },
    ],
  },
];

test('changesFromChangelog: only after "since", without noise, with stable ids', () => {
  const out = changesFromChangelog(histories, Date.UTC(2026, 9, 1, 10));
  assert.deepEqual(out.map(c => [c.id, c.field, c.label, c.from, c.to]), [
    ['h2-1', 'fixVersion', 'Fix Version', null, '2026.10'],
    ['h2-2', 'other', 'Story Points', '3', '5'],
  ]);
  assert.deepEqual(out[0].author, { accountId: 'a1', name: 'Alex' });
  assert.equal(changesFromChangelog(histories, null).length, 3);
});

test('changesFromComments converts ADF to text', () => {
  const out = changesFromComments([{
    id: '55', author, created: '2026-10-03T10:00:00.000+0000',
    body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi ' }, { type: 'mention', attrs: { text: '@Sam' } }] }] },
  }], Date.UTC(2026, 9, 2));
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'c55');
  assert.equal(out[0].field, 'comment');
  assert.equal(out[0].to, 'Hi @Sam');
});

test('changesFromComments: an edit after "since" to an older comment is one change, by the editor, with the new text', () => {
  const sam = { accountId: 'a2', displayName: 'Sam' };
  const since = Date.UTC(2026, 9, 2);
  const edited = {
    id: '56', author, updateAuthor: sam, created: '2026-10-01T10:00:00.000+0000', updated: '2026-10-03T09:30:00.000+0000', body: 'Legal approved the text, can ship.',
  };
  const out = changesFromComments([edited], since, new Map([['56', 'Waiting for the legal check.']]));
  assert.deepEqual(out, [{
    id: `c56@${Date.UTC(2026, 9, 3, 9, 30)}`, at: Date.UTC(2026, 9, 3, 9, 30), author: { accountId: 'a2', name: 'Sam' }, field: 'comment', label: 'Comment',
    edited: true, from: 'Waiting for the legal check.', to: 'Legal approved the text, can ship.',
  }]);
  // Without the old text, only the new one
  assert.equal(changesFromComments([edited], since)[0].from, null);
  // Without an updateAuthor the author edited it
  assert.deepEqual(changesFromComments([{ ...edited, updateAuthor: undefined }], since)[0].author, { accountId: 'a1', name: 'Alex' });
});

test('changesFromComments: an edit before "since" gives nothing', () => {
  const out = changesFromComments([{ id: '56', author, created: '2026-10-01T10:00:00.000+0000', updated: '2026-10-01T12:00:00.000+0000', body: 'x' }], Date.UTC(2026, 9, 2));
  assert.deepEqual(out, []);
});

test('changesFromComments: a comment created and edited after "since" is one new comment with its latest text', () => {
  const out = changesFromComments([{ id: '57', author, created: '2026-10-03T10:00:00.000+0000', updated: '2026-10-03T11:00:00.000+0000', body: 'Latest text' }], Date.UTC(2026, 9, 2));
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'c57');
  assert.equal(out[0].at, Date.UTC(2026, 9, 3, 10));
  assert.equal(out[0].to, 'Latest text');
  assert.ok(!out[0].edited);
});

test('changesFromComments: an edit that leaves the text as IssueMon saw it gives nothing', () => {
  const comment = { id: '56', author, created: '2026-10-01T10:00:00.000+0000', updated: '2026-10-03T09:30:00.000+0000', body: 'Same text' };
  assert.deepEqual(changesFromComments([comment], Date.UTC(2026, 9, 2), new Map([['56', 'Same text']])), []);
});

test('changesFromComments: a comment created after "since" that IssueMon already saw counts only when edited', () => {
  // Created after the issue's last seen update but already recorded, e.g. during the previous check
  const since = Date.UTC(2026, 9, 2);
  const comment = { id: '58', author, created: '2026-10-03T10:00:00.000+0000', updated: '2026-10-03T10:00:00.000+0000', body: 'First text' };
  assert.deepEqual(changesFromComments([comment], since, new Map([['58', 'First text']])), []);
  const out = changesFromComments([{ ...comment, updated: '2026-10-03T11:00:00.000+0000', body: 'Second text' }], since, new Map([['58', 'First text']]));
  assert.equal(out.length, 1);
  assert.equal(out[0].id, `c58@${Date.UTC(2026, 9, 3, 11)}`);
  assert.equal(out[0].edited, true);
  assert.equal(out[0].from, 'First text');
  assert.equal(out[0].to, 'Second text');
});

test('adfToText: paragraphs, lists and line breaks', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'First' }, { type: 'hardBreak' }, { type: 'text', text: 'line' }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] }] },
      { type: 'paragraph', content: [{ type: 'emoji', attrs: { shortName: ':smile:', text: '😄' } }] },
    ],
  };
  assert.equal(adfToText(doc), 'First\nline\n\n• a\n• b\n\n😄');
});

test('changesFromSnapshots as a fallback', () => {
  const prev = { status: 'To Do', assignee: null, priority: 'Low', summary: 'x', labels: [], fixVersions: [], updated: 1 };
  const next = { ...prev, status: 'Done', assignee: { name: 'Sam' }, updated: 2 };
  assert.deepEqual(changesFromSnapshots(prev, next).map(c => [c.field, c.from, c.to]), [['status', 'To Do', 'Done'], ['assignee', null, 'Sam']]);
});

test('changesFromSnapshots compares assignees by account id, so a nameless user is not unassigned', () => {
  const base = { status: 'To Do', priority: 'Low', summary: 'x', labels: [], fixVersions: [], updated: 1 };
  const nameless = { accountId: 'acc-x', name: null };
  const fields = (a, b) => changesFromSnapshots({ ...base, assignee: a }, { ...base, assignee: b, updated: 2 }).map(c => c.field);
  assert.deepEqual(fields(null, nameless), ['assignee']);
  assert.deepEqual(fields(nameless, null), ['assignee']);
  assert.deepEqual(fields(nameless, { accountId: 'acc-y', name: null }), ['assignee']);
  assert.deepEqual(fields(nameless, { accountId: 'acc-x', name: 'Renamed' }), []); // same account, new name
  assert.deepEqual(fields({ name: 'Sam' }, { name: 'Sam' }), []); // no ids: by name
  assert.deepEqual(fields({ name: 'Sam' }, { name: 'Alex' }), ['assignee']);
});

test('staleJql builds a bounded query', () => {
  assert.equal(staleJql({ staleDays: 14, excluded: ['Closed', 'On hold'] }), 'assignee = currentUser() AND statusCategory != Done AND status NOT IN ("Closed", "On hold") AND updated <= -14d ORDER BY updated ASC'); // oldest first by default
  assert.equal(staleJql({ staleDays: '7', excluded: [] }), 'assignee = currentUser() AND statusCategory != Done AND updated <= -7d ORDER BY updated ASC');
  assert.match(staleJql({ staleDays: 3, excluded: ['Won"t do'] }), /"Won\\"t do"/);
  assert.match(staleJql({ staleDays: 14, excluded: [], staleSort: 'newest' }), /ORDER BY updated DESC$/);
  assert.match(staleJql({ staleDays: 14, excluded: [], staleSort: 'oldest' }), /ORDER BY updated ASC$/);
});

test('staleJql: Backlog is just a status, without duplicates and with statuses to skip', () => {
  assert.equal(staleJql({ staleDays: 14, excluded: ['Closed', 'On hold', 'Backlog'] }), 'assignee = currentUser() AND statusCategory != Done AND status NOT IN ("Closed", "On hold", "Backlog") AND updated <= -14d ORDER BY updated ASC');
  assert.equal(staleJql({ staleDays: 14, excluded: ['Closed', 'backlog', 'Backlog'] }), 'assignee = currentUser() AND statusCategory != Done AND status NOT IN ("Closed", "backlog") AND updated <= -14d ORDER BY updated ASC');
  assert.equal(staleJql({ staleDays: 14, excluded: ['Closed'], excludeBacklog: true }), 'assignee = currentUser() AND statusCategory != Done AND status NOT IN ("Closed") AND updated <= -14d ORDER BY updated ASC'); // the old flag no longer does anything
  assert.equal(staleJql({ staleDays: 14, excluded: ['Closed', 'On hold'], skip: ['on hold'] }), 'assignee = currentUser() AND statusCategory != Done AND status NOT IN ("Closed") AND updated <= -14d ORDER BY updated ASC');
});

test('staleJql: backslashes and double quotes reach Jira exactly as typed', () => {
  const excluded = ['On hold\\', 'Say "hi"', 'C:\\temp\\"x"', "Won't Fix"];
  const jql = staleJql({ staleDays: 14, excluded });
  assert.match(jql, /"On hold\\\\", "Say \\"hi\\""/);
  assert.deepEqual(jqlList(jql, 'status\\s+NOT\\s+IN'), excluded); // read back like Jira does
  assert.deepEqual(jqlList(staleJql({ staleDays: 14, excluded: [], people: ['a\\b"c'] }), 'assignee\\s+IN'), ['a\\b"c']);
});

test('mock Jira reads JQL strings strictly: an unterminated string is an error', () => {
  assert.throws(() => jqlList('status NOT IN ("On hold\\")', 'status\\s+NOT\\s+IN'), /has not been completed/); // what an unescaped backslash used to produce
  assert.deepEqual(jqlList('status NOT IN ("A, B", C)', 'status\\s+NOT\\s+IN'), ['A, B', 'C']);
});

test('unknownStatuses: reads the names from Jira\'s 400, also with quotes in them or in another language', () => {
  const en = s => `The value '${s}' does not exist for the field 'status'.`;
  assert.deepEqual(unknownStatuses([en('Live')], ['Live', 'Closed']), ['Live']);
  assert.deepEqual(unknownStatuses([en("Won't Fix")], ["Won't Fix"]), ["Won't Fix"]);
  assert.deepEqual(unknownStatuses([en('Live'), en("It's 'on'")], []), ['Live', "It's 'on'"]);
  assert.deepEqual(unknownStatuses([], ['Live']), []);
  assert.deepEqual(unknownStatuses(undefined, ['Live']), []);
  // each message on its own: the lazy match does not run from one message into the next
  assert.deepEqual(unknownStatuses(["The value 'acc-1' does not exist for the field 'assignee'.", en('Live')], ['Live']), ['Live']);
});

test('unknownStatuses: in another language the sent name must stand between quotes in Jira\'s message', () => {
  const sent = ['Closed', "Won't Fix", 'Fix', 'Live'];
  assert.deepEqual(unknownStatuses(["La valeur « Won't Fix » n'existe pas pour le champ 'status'."], sent), ["Won't Fix"]);
  assert.deepEqual(unknownStatuses(['Der Wert „Live“ existiert nicht für das Feld „status“.'], sent), ['Live']);
  assert.deepEqual(unknownStatuses(['El valor “live” no existe.'], sent), ['Live']); // case-insensitive
  assert.deepEqual(unknownStatuses(['De waarde ‘Live’ bestaat niet.'], sent), ['Live']);
  assert.deepEqual(unknownStatuses(['De waarde "Closed" en \'Live\' bestaan niet.'], sent), ['Closed', 'Live']);
  assert.deepEqual(unknownStatuses(["De waarde 'Won't Fix' bestaat niet."], sent), ["Won't Fix"]); // "Fix" alone is not quoted
  // without quotes a name proves nothing, also not as a whole word or inside one
  assert.deepEqual(unknownStatuses(['Der Wert Live existiert nicht. Please fix the Closed query.'], sent), []);
  assert.deepEqual(unknownStatuses(['Something else is wrong.'], sent), []);
});

test('staleJql: issues of several people, by account id', () => {
  assert.equal(staleJql({ staleDays: 14, excluded: ['Closed'], people: ['acc-me', '712020:abc-def'] }),
    'assignee IN ("acc-me", "712020:abc-def") AND statusCategory != Done AND status NOT IN ("Closed") AND updated <= -14d ORDER BY updated ASC');
  assert.match(staleJql({ staleDays: 14, excluded: [], people: [] }), /^assignee = currentUser\(\)/);
});

test('staleJql: issues without an assignee too, in parentheses so the other conditions apply to both', () => {
  assert.equal(staleJql({ staleDays: 14, excluded: ['Closed'], staleUnassigned: true }),
    '(assignee = currentUser() OR assignee IS EMPTY) AND statusCategory != Done AND status NOT IN ("Closed") AND updated <= -14d ORDER BY updated ASC');
  assert.equal(staleJql({ staleDays: 14, excluded: [], people: ['acc-me', 'acc-sam'], staleUnassigned: true }),
    '(assignee IN ("acc-me", "acc-sam") OR assignee IS EMPTY) AND statusCategory != Done AND updated <= -14d ORDER BY updated ASC');
  assert.match(staleJql({ staleDays: 14, excluded: [], staleUnassigned: false }), /^assignee = currentUser\(\) AND /);
});

test('excludedProject: each pattern applies to name and key, with * as wildcard, case-insensitive and otherwise exact', () => {
  const skip = excludedProject({ excludedProjects: ['ARCHIVE-*', 'Client (old)', 'dev'] });
  const is = (project, projectKey) => skip({ project, projectKey });
  assert.equal(is('ARCHIVE-Old', 'OLD'), true); // by name
  assert.equal(is('ARCHIVE-Old client - Roadmap', 'OLD'), true);
  assert.equal(is('archive-small', 'K'), true);
  assert.equal(is('Development', 'DEV'), true); // by key
  assert.equal(is('Website ARCHIVE-', 'WEB'), false); // ARCHIVE-* only at the start
  assert.equal(is('Client (old)', 'CO'), true); // parentheses are ordinary characters
  assert.equal(is('Client (old) 2', 'CO2'), false);
  assert.equal(is('DevOps', 'DEVOPS'), false); // dev is not a prefix
  assert.equal(is(null, null), false);
  assert.equal(excludedProject({})({ project: 'ARCHIVE-x', projectKey: 'X' }), false);
});

test('comment mentions preserve account ids and exact ranges through ADF formatting', () => {
  const body = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: '  @Demo User is plain text. ' }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [
      { type: 'mention', attrs: { id: 'acc-me', text: '@Demo User' } },
      { type: 'text', text: ' <img src=x> ' },
      { type: 'mention', attrs: { id: 'acc-other', text: '@Demo User' } },
    ] }] }] },
  ] };
  const [c] = changesFromComments([{ id: '1', author, created: '2026-10-03', body }], null);
  assert.equal(c.to, '@Demo User is plain text. \n\n• @Demo User <img src=x> @Demo User');
  assert.deepEqual(c.mentions.map(m => [m.accountId, c.to.slice(m.start, m.end)]), [['acc-me', '@Demo User'], ['acc-other', '@Demo User']]);
  assert.equal(c.mentions[0].start, c.to.indexOf('@Demo User', 1));
  assert.equal(c.mentionsMe, undefined); // the tracker supplies the current account
});

test('a same-text edit that changes the mention account is recorded', () => {
  const body = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'new', text: '@Sam' } }] }] };
  const [c] = changesFromComments([{ id: '1', author, created: '2026-10-01', updated: '2026-10-03', body }], Date.UTC(2026, 9, 2), new Map([
    ['1', { text: '@Sam', mentions: [{ start: 0, end: 4, accountId: 'old' }] }],
  ]));
  assert.equal(c.edited, true);
  assert.equal(c.from, '@Sam');
  assert.equal(c.mentions[0].accountId, 'new');
});

const dateDoc = timestamp => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [
  { type: 'text', text: 'Due ' }, { type: 'date', attrs: { timestamp } },
] }] });

test('a date node: a millisecond timestamp gives YYYY-MM-DD, anything else its raw value, and nothing throws', () => {
  for (const [timestamp, shown] of [
    [String(Date.UTC(2026, 9, 17, 12)), '2026-10-17'], [Date.UTC(2026, 9, 17, 12), '2026-10-17'],
    ['2026-10-17', '2026-10-17'], ['abc', 'abc'], ['99999999999999999', '99999999999999999'], [1e17, '100000000000000000'],
    ['0x10', '0x10'], ['NaN', 'NaN'], ['1e3', '1e3'],
  ]) {
    const text = `Due ${shown}`;
    assert.equal(adfToText(dateDoc(timestamp)), text, JSON.stringify(timestamp));
    // In a description: normalizeIssue must not throw
    assert.equal(normalizeIssue({ id: '10001', key: 'WEB-1', fields: { description: dateDoc(timestamp) } }).description, text);
    // In a comment: changesFromComments must not throw, and the comment is reported
    const out = changesFromComments([{ id: '9', author, created: '2026-10-03T10:00:00.000+0000', body: dateDoc(timestamp) }], Date.UTC(2026, 9, 2));
    assert.deepEqual(out.map(c => c.to), [text]);
  }
  // No usable value: nothing to show
  for (const timestamp of [undefined, null, '', {}, ['x']]) assert.equal(adfToText(dateDoc(timestamp)), 'Due', JSON.stringify(timestamp));
});

test('adfToText: schema-valid nodes with missing or odd attributes never throw', () => {
  const doc = content => ({ type: 'doc', version: 1, content });
  const odd = [
    { type: 'mention', attrs: { text: 5, id: {} } },
    { type: 'mention', attrs: null },
    { type: 'emoji', attrs: { text: 5, shortName: {} } },
    { type: 'emoji' },
    { type: 'inlineCard', attrs: { url: 7 } },
    { type: 'blockCard', attrs: [] },
    { type: 'status', attrs: { text: {} } },
    { type: 'status', attrs: 'x' },
    { type: 'text', text: 5 },
    { type: 'text' },
    { type: 'date' },
    { type: 'paragraph', content: 'oops' },
    { type: 'paragraph', content: [null, 5, 'raw', {}] },
    { type: 'bulletList', content: [null, { type: 'listItem' }, 5] },
    { type: 'table', content: [null, 5, { type: 'tableRow' }, { type: 'tableRow', content: [null, { type: 'tableCell' }] }] },
    { type: 5 },
    { type: 'table', content: 'oops' },
    { type: 'orderedList', content: {} },
  ];
  for (const node of odd) {
    assert.equal(typeof adfToText(doc([node])), 'string', JSON.stringify(node));
    assert.equal(typeof adfToText(doc([{ type: 'paragraph', content: [node] }])), 'string', JSON.stringify(node));
  }
  const between = node => adfToText(doc([{ type: 'paragraph', content: [{ type: 'text', text: 'a' }, node, { type: 'text', text: 'b' }] }]));
  assert.equal(between({ type: 'emoji', attrs: { text: 5 } }), 'ab');
  assert.equal(between({ type: 'text', text: 5 }), 'ab');
});
