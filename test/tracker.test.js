'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Tracker, ensureShape } = require('../src/main/tracker');
const { createJiraClient } = require('../src/main/jira');
const { createMockJira } = require('./support/mock-jira');

const DAY = 86_400_000;

/** Tracker against a fresh mock Jira, without real timers or storage. */
async function setup(t, settings = {}, { env } = {}) {
  const jira = createMockJira({ email: 'user@example.com', token: 'tok' });
  const url = await jira.start();
  t.after(() => jira.stop());
  const notes = [];
  const timers = [];
  const store = { data: { settings: { baseUrl: url, email: 'user@example.com', ...settings } }, saves: 0, save() { this.saves++; } };
  let token = 'tok';
  const tracker = new Tracker({
    store,
    hasToken: () => !!token,
    setToken: v => { token = v || null; },
    getClient: () => (token ? createJiraClient({ baseUrl: store.data.settings.baseUrl, email: 'user@example.com', token, t: tracker.t }) : null), // like main: the client words errors in the tracker's language
    notify: n => notes.push(n),
    setTimer: (fn, ms) => { timers.push(ms); return timers.length; },
    clearTimer: () => {},
    env,
  });
  return { jira, tracker, notes, timers, store, setToken: v => { token = v; } };
}

test('adding issues: found, unknown and duplicate', async t => {
  const { jira, tracker } = await setup(t);
  jira.addIssue({ key: 'WEB-1', summary: 'One' });
  const r = await tracker.addIssues('https://x.atlassian.net/browse/WEB-1 and WEB-9');
  assert.deepEqual(r, { ok: true, added: ['WEB-1'], duplicates: [], notFound: ['WEB-9'] });
  assert.deepEqual(tracker.data.tracked.map(x => x.key), ['WEB-1']);
  assert.equal(tracker.find('WEB-1').changes.length, 0);
  const again = await tracker.addIssues('web-1');
  assert.deepEqual(again.duplicates, ['WEB-1']);
});

test('without an account nothing can be added', async t => {
  const { tracker, setToken } = await setup(t);
  setToken(null);
  const r = await tracker.addIssues('WEB-1');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Connect your Jira account in Settings first.');
});

test('an assignment followed by a comment leads the notification title and body', async t => {
  const { jira, tracker, notes } = await setup(t);
  jira.addIssue({ key: 'WEB-1', summary: 'Checkout broken', updated: Date.now() - DAY });
  await tracker.addIssues('WEB-1');
  tracker.data.me = { accountId: jira.people.me.accountId, name: jira.people.me.displayName };
  jira.change('WEB-1', { field: 'assignee', from: 'Jordan Lee', to: 'Demo User', author: jira.people.alex });
  jira.comment('WEB-1', 'Handing this over, I am on holiday from tomorrow.', jira.people.sam, Date.now() + 1000);
  assert.deepEqual(await tracker.check(), { ok: true, found: 2 });
  assert.deepEqual(notes, [{ title: 'WEB-1 was assigned to you', subtitle: 'Checkout broken', body: 'Alex Morgan · Assigned to you', key: 'WEB-1' }]);
});

test('check finds changes after the baseline and notifies them', async t => {
  const { jira, tracker, notes } = await setup(t);
  const { alex, sam } = jira.people;
  jira.addIssue({ key: 'WEB-1', summary: 'Checkout broken', status: 'In Progress', updated: Date.now() - DAY });
  jira.change('WEB-1', { field: 'status', from: 'To Do', to: 'In Progress', author: alex, at: Date.now() - DAY });
  await tracker.addIssues('WEB-1');

  // Nothing changed → nothing new, no changelog request
  const before = jira.requests.length;
  assert.deepEqual(await tracker.check(), { ok: true, found: 0 });
  assert.ok(!jira.requests.slice(before).some(r => r.path.endsWith('/changelog')));

  jira.change('WEB-1', { field: 'status', from: 'In Progress', to: 'Review', author: alex });
  jira.comment('WEB-1', 'Can you take a look?', sam);
  const r = await tracker.check();
  assert.deepEqual(r, { ok: true, found: 2 });
  const entry = tracker.find('WEB-1');
  assert.deepEqual(entry.changes.map(c => [c.field, c.to, c.processed]), [['status', 'Review', false], ['comment', 'Can you take a look?', false]]);
  assert.equal(entry.issue.status, 'Review');
  assert.equal(tracker.changedCount(), 1);
  assert.deepEqual(notes, [{ title: 'WEB-1 · 2 changes', subtitle: 'Checkout broken', body: 'Sam Rivera: “Can you take a look?”', key: 'WEB-1' }]);

  // The same changes are not notified again
  assert.deepEqual(await tracker.check(), { ok: true, found: 0 });
  assert.equal(entry.changes.length, 2);
});

test('a date in a description or comment that is no timestamp does not stop the checks', async t => {
  const { jira, tracker } = await setup(t);
  const { alex, sam } = jira.people;
  const withDate = timestamp => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [
    { type: 'text', text: 'Due ' }, { type: 'date', attrs: { timestamp } },
  ] }] });
  jira.addIssue({ key: 'WEB-1', summary: 'Odd description', description: withDate('2026-10-17'), updated: Date.now() - DAY });
  jira.addIssue({ key: 'WEB-2', summary: 'Odd comment', updated: Date.now() - DAY });
  jira.addIssue({ key: 'WEB-3', summary: 'Normal', updated: Date.now() - DAY });

  // Tracking the issue with the odd description works, and its description reads as written
  const added = await tracker.addIssues('WEB-1 WEB-2 WEB-3');
  assert.equal(added.ok, true);
  assert.equal(tracker.find('WEB-1').issue.description, 'Due 2026-10-17');

  // Odd dates in a comment and a new comment on a normal issue: all recorded in one check
  jira.comment('WEB-2', withDate('abc'), sam);
  jira.change('WEB-3', { field: 'status', from: 'To Do', to: 'Review', author: alex });
  assert.deepEqual(await tracker.check(), { ok: true, found: 2 });
  assert.deepEqual(tracker.find('WEB-2').changes.map(c => [c.field, c.to]), [['comment', 'Due abc']]);
  assert.deepEqual(tracker.find('WEB-3').changes.map(c => [c.field, c.to]), [['status', 'Review']]);
  assert.equal(tracker.find('WEB-2').error ?? null, null);
  assert.deepEqual(await tracker.check(), { ok: true, found: 0 }); // and nothing is reported twice
});

test('own changes are stored silently as processed', async t => {
  const { jira, tracker, notes } = await setup(t, { ignoreOwn: true });
  jira.addIssue({ key: 'WEB-1', summary: 'x', updated: Date.now() - DAY });
  await tracker.addIssues('WEB-1');
  await tracker.check(); // fetches "me"
  jira.comment('WEB-1', 'Done myself', jira.people.me);
  await tracker.check();
  const c = tracker.find('WEB-1').changes[0];
  assert.equal(c.processed, true);
  assert.equal(c.own, true);
  assert.equal(notes.length, 0);
  assert.equal(tracker.changedCount(), 0);
});

test('an edited comment is one pending change per edit, with the old text when IssueMon saw it', async t => {
  const { jira, tracker, notes } = await setup(t);
  const { priya, sam } = jira.people;
  const now = Date.now();
  jira.addIssue({ key: 'WEB-1', summary: 'Footer links', updated: now - 3 * DAY });
  const old = jira.comment('WEB-1', 'Waiting for the legal check.', priya, now - 3 * DAY).comments[0].id;
  await tracker.addIssues('WEB-1');

  jira.editComment('WEB-1', old, 'Legal approved the text, can ship.', priya, now - 2 * DAY);
  assert.deepEqual(await tracker.check(), { ok: true, found: 1 });
  const entry = tracker.find('WEB-1');
  assert.deepEqual(entry.changes.map(c => [c.id, c.edited, c.from, c.to, c.processed]), [
    [`c${old}@${now - 2 * DAY}`, true, null, 'Legal approved the text, can ship.', false], // seen before tracking: no old text
  ]);
  assert.deepEqual(notes.pop(), { title: 'WEB-1 changed', subtitle: 'Footer links', body: 'Priya Patel edited a comment: “Legal approved the text, can ship.”', key: 'WEB-1' });

  // A re-check without an edit adds nothing
  assert.deepEqual(await tracker.check(), { ok: true, found: 0 });
  assert.equal(entry.changes.length, 1);

  // A second edit is a new change, with the text of the first edit as the old text
  jira.editComment('WEB-1', old, 'Legal approved the text, ship it on Monday.', priya, now - DAY);
  assert.deepEqual(await tracker.check(), { ok: true, found: 1 });
  assert.deepEqual(entry.changes.slice(1).map(c => [c.id, c.from, c.to]), [
    [`c${old}@${now - DAY}`, 'Legal approved the text, can ship.', 'Legal approved the text, ship it on Monday.'],
  ]);

  // A comment IssueMon recorded as new, edited later: the recorded text is the old text
  const fresh = jira.comment('WEB-1', 'PR is ready.', sam, now - DAY / 2).comments[1].id;
  await tracker.check();
  jira.editComment('WEB-1', fresh, 'PR is ready for review.', sam, now - DAY / 4);
  assert.deepEqual(await tracker.check(), { ok: true, found: 1 });
  const last = entry.changes.at(-1);
  assert.deepEqual([last.id, last.author.name, last.from, last.to], [`c${fresh}@${now - DAY / 4}`, 'Sam Rivera', 'PR is ready.', 'PR is ready for review.']);
});

test('your own comment edits follow "Don\'t notify my own changes"', async t => {
  const { jira, tracker, notes } = await setup(t, { ignoreOwn: true });
  const { me } = jira.people;
  jira.addIssue({ key: 'WEB-1', summary: 'x', updated: Date.now() - 2 * DAY });
  const id = jira.comment('WEB-1', 'Draft', me, Date.now() - 2 * DAY).comments[0].id;
  await tracker.addIssues('WEB-1');
  await tracker.check(); // fetches "me"
  jira.editComment('WEB-1', id, 'Final', me);
  await tracker.check();
  const [c] = tracker.find('WEB-1').changes;
  assert.deepEqual([c.edited, c.processed, c.own], [true, true, true]);
  assert.equal(notes.length, 0);
});

test('changedIssues: only issues with open changes, newest first', async t => {
  const { jira, tracker } = await setup(t);
  const now = Date.now();
  jira.addIssue({ key: 'WEB-1', summary: 'Old', updated: now - 3 * DAY });
  jira.addIssue({ key: 'WEB-2', summary: 'New', updated: now - 3 * DAY });
  jira.addIssue({ key: 'WEB-3', summary: 'Unchanged', updated: now - 3 * DAY });
  await tracker.addIssues('WEB-1 WEB-2 WEB-3');
  assert.deepEqual(tracker.changedIssues(), []);

  jira.change('WEB-1', { field: 'status', from: 'To Do', to: 'Review', author: jira.people.alex, at: now - 2 * DAY });
  jira.change('WEB-2', { field: 'status', from: 'To Do', to: 'Review', author: jira.people.alex, at: now - DAY });
  await tracker.check();
  const list = tracker.changedIssues();
  assert.deepEqual(list.map(x => [x.key, x.summary]), [['WEB-2', 'New'], ['WEB-1', 'Old']]);
  assert.ok(list[0].at > list[1].at);

  tracker.markProcessed(['WEB-2']);
  assert.deepEqual(tracker.changedIssues().map(x => x.key), ['WEB-1']);
});

test('process, undo, untrack and restore', async t => {
  const { jira, tracker } = await setup(t);
  jira.addIssue({ key: 'WEB-1', summary: 'x', updated: Date.now() - DAY });
  await tracker.addIssues('WEB-1');
  jira.comment('WEB-1', 'a');
  jira.comment('WEB-1', 'b');
  await tracker.check();
  const ids = tracker.markProcessed(['WEB-1']);
  assert.equal(ids.length, 2);
  assert.equal(tracker.changedCount(), 0);
  assert.ok(tracker.find('WEB-1').changes.every(c => c.processed && c.processedAt));
  tracker.unmark(ids);
  assert.equal(tracker.changedCount(), 1);

  assert.equal(tracker.untrack('WEB-1'), true);
  assert.equal(tracker.find('WEB-1'), undefined);
  assert.equal(tracker.restore('WEB-1'), true);
  assert.equal(tracker.find('WEB-1').changes.length, 2);
});

test('a vanished issue gets an error message but stays tracked', async t => {
  const { jira, tracker } = await setup(t);
  jira.addIssue({ key: 'WEB-1', summary: 'x' });
  await tracker.addIssues('WEB-1');
  jira.remove('WEB-1');
  await tracker.check();
  assert.equal(tracker.find('WEB-1').error, 'Not found, or no longer accessible');
});

test('a vanished issue: one pending change and a notification, once', async t => {
  const { jira, tracker, notes } = await setup(t);
  jira.addIssue({ key: 'WEB-1', summary: 'Checkout broken', updated: Date.now() - DAY });
  await tracker.addIssues('WEB-1');
  jira.remove('WEB-1');
  assert.deepEqual(await tracker.check(), { ok: true, found: 1 });
  const entry = tracker.find('WEB-1');
  assert.deepEqual(entry.changes.map(c => [c.field, c.processed]), [['gone', false]]);
  assert.equal(tracker.changedCount(), 1);
  assert.deepEqual(notes, [{ title: 'WEB-1 changed', subtitle: 'Checkout broken', body: 'No longer accessible (deleted, or you no longer have access)', key: 'WEB-1' }]);

  // A second check that still misses it adds nothing
  assert.deepEqual(await tracker.check(), { ok: true, found: 0 });
  assert.equal(entry.changes.length, 1);
  assert.equal(notes.length, 1);

  // Processed: out of Changed, still tracked with the error
  tracker.markProcessed(['WEB-1']);
  assert.equal(tracker.changedCount(), 0);
  await tracker.check();
  assert.equal(tracker.find('WEB-1').error, 'Not found, or no longer accessible');
  assert.equal(entry.changes.length, 1);
});

test('a vanished issue: a failed fetch is not a vanished issue', async t => {
  const { jira, tracker, notes } = await setup(t);
  jira.addIssue({ key: 'WEB-1', summary: 'x', updated: Date.now() - DAY });
  await tracker.addIssues('WEB-1');
  jira.remove('WEB-1');
  const down = Object.assign(new Error('No connection to Jira.'), { code: 'network' });
  const real = tracker.getClient;
  tracker.getClient = () => ({ ...real(), bulkFetch: async () => { throw down; } });
  assert.equal((await tracker.check()).ok, false);
  const failing = Object.assign(new Error('Jira had a problem (500).'), { status: 500 });
  tracker.getClient = () => ({ ...real(), bulkFetch: async () => { throw failing; } });
  assert.equal((await tracker.check()).ok, false);
  const entry = tracker.find('WEB-1');
  assert.deepEqual(entry.changes, []);
  assert.equal(entry.error ?? null, null);
  assert.equal(notes.length, 0);
});

test('a vanished issue that comes back: the error clears silently and an open "gone" change is processed', async t => {
  const { jira, tracker, notes } = await setup(t);
  jira.addIssue({ key: 'WEB-1', summary: 'x', updated: Date.now() - DAY });
  await tracker.addIssues('WEB-1');
  jira.remove('WEB-1');
  await tracker.check();
  assert.equal(tracker.changedCount(), 1);
  jira.restore('WEB-1');
  assert.deepEqual(await tracker.check(), { ok: true, found: 0 });
  const entry = tracker.find('WEB-1');
  assert.equal(entry.error, null);
  assert.equal(tracker.changedCount(), 0);
  assert.deepEqual(entry.changes.map(c => [c.field, c.processed]), [['gone', true]]);
  assert.equal(notes.length, 1); // only the one about it vanishing

  // Gone again later: reported again
  jira.remove('WEB-1');
  assert.deepEqual(await tracker.check(), { ok: true, found: 1 });
  assert.equal(entry.changes.filter(c => !c.processed).length, 1);
});

/** A tracker that has done its first check, so it knows who is connected, with these issues tracked. */
async function trackedSetup(t, ...keys) {
  const ctx = await setup(t);
  for (const key of keys) ctx.jira.addIssue({ key, summary: `Issue ${key}`, updated: Date.now() - DAY });
  await ctx.tracker.addIssues(keys.join(' '));
  assert.equal((await ctx.tracker.check()).ok, true);
  return ctx;
}

test('a vanished issue: a 200 that is no real answer reports nothing, and the check fails and is retried', async t => {
  const { jira, tracker, notes, timers } = await trackedSetup(t, 'WEB-1');
  jira.remove('WEB-1');
  for (const body of [{}, '', null, { issues: null }, { issueErrors: [] }]) {
    jira.bulkfetchBody = body;
    const r = await tracker.check();
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.equal(tracker.status.state, 'error');
    assert.equal(timers.at(-1) <= 5 * 60_000, true); // a server-like error: back off, shorter than the 10 minute interval
  }
  const entry = tracker.find('WEB-1');
  assert.deepEqual(entry.changes, []);
  assert.equal(entry.missingSince, undefined);
  assert.equal(entry.error ?? null, null);
  assert.equal(notes.length, 0);
});

test('a vanished issue: one named in issueErrors had a temporary error, and that says nothing about it', async t => {
  const { jira, tracker, notes } = await trackedSetup(t, 'WEB-1');
  const entry = tracker.find('WEB-1');
  jira.issueErrorIds = [entry.id]; // by id: that is what the check asks for
  assert.deepEqual(await tracker.check(), { ok: true, found: 0 });
  assert.deepEqual(entry.changes, []);
  assert.equal(entry.error ?? null, null);
  assert.equal(entry.missingSince, undefined);
  assert.equal(notes.length, 0);

  // Also when it was already gone: the state stays as it was
  jira.issueErrorIds = [];
  jira.remove('WEB-1');
  await tracker.check();
  assert.equal(entry.changes.length, 1);
  jira.issueErrorIds = [entry.id];
  assert.deepEqual(await tracker.check(), { ok: true, found: 0 });
  assert.equal(entry.error, 'Not found, or no longer accessible');
  assert.equal(entry.changes.length, 1);
  jira.restore('WEB-1'); // back, but Jira can't return it right now: still no word
  await tracker.check();
  assert.equal(entry.error, 'Not found, or no longer accessible');
  assert.ok(entry.missingSince);
  assert.equal(notes.length, 1);
});

test('a vanished issue: left out of issues and of issueErrors, it is reported once', async t => {
  const { jira, tracker, notes } = await trackedSetup(t, 'WEB-1', 'WEB-2');
  jira.remove('WEB-1');
  assert.deepEqual(await tracker.check(), { ok: true, found: 1 });
  assert.deepEqual(tracker.find('WEB-1').changes.map(c => c.field), ['gone']);
  assert.deepEqual(tracker.find('WEB-2').changes, []);
  assert.equal(notes.length, 1);
});

test('a vanished issue: counted by id once the id is known, not only by key', async t => {
  const { jira, tracker } = await trackedSetup(t, 'WEB-1');
  assert.ok(tracker.find('WEB-1').id);
  jira.remove('WEB-1');
  assert.deepEqual(await tracker.check(), { ok: true, found: 1 }); // the request goes out by id
});

test('a vanished issue: when myself() fails nothing is reported and the check fails', async t => {
  const { jira, tracker, notes } = await trackedSetup(t, 'WEB-1');
  jira.remove('WEB-1');
  jira.myselfStatus = 401; // an expired token: bulkfetch answers 200 with an error for every issue, /myself says who you are
  const r = await tracker.check();
  assert.equal(r.ok, false);
  assert.equal(tracker.status.code, 'auth');
  const entry = tracker.find('WEB-1');
  assert.deepEqual(entry.changes, []);
  assert.equal(entry.missingSince, undefined);
  assert.equal(notes.length, 0);

  jira.myselfStatus = null;
  assert.deepEqual(await tracker.check(), { ok: true, found: 1 });
  assert.equal(notes.length, 1);
});

test('a vanished issue: when another account answers nothing is reported in that check', async t => {
  const { jira, tracker, notes } = await trackedSetup(t, 'WEB-1');
  tracker.data.me = { accountId: 'acc-someone-else', name: 'Someone Else' };
  jira.remove('WEB-1');
  assert.deepEqual(await tracker.check(), { ok: true, found: 0 });
  const entry = tracker.find('WEB-1');
  assert.equal(entry.error, 'Not found, or no longer accessible'); // red row only
  assert.deepEqual(entry.changes, []);
  assert.equal(entry.missingSince, undefined);
  assert.equal(notes.length, 0);
  assert.equal(tracker.data.me.accountId, jira.people.me.accountId); // who is connected is up to date again

  assert.deepEqual(await tracker.check(), { ok: true, found: 1 });
});

test('a vanished issue: two issues gone in one check have their own change, and undo of one leaves the other', async t => {
  const { jira, tracker } = await trackedSetup(t, 'WEB-1', 'WEB-2');
  jira.remove('WEB-1');
  jira.remove('WEB-2');
  assert.deepEqual(await tracker.check(), { ok: true, found: 2 });
  const [a, b] = ['WEB-1', 'WEB-2'].map(k => tracker.find(k).changes[0]);
  assert.notEqual(a.id, b.id);
  const ids = tracker.markProcessed(['WEB-1', 'WEB-2']);
  assert.equal(ids.length, 2);
  tracker.unmark([a.id]);
  assert.equal(a.processed, false);
  assert.equal(b.processed, true);
  assert.equal(tracker.changedCount(), 1);
});

test('a vanished issue: the first check after changing the account is quiet, and so are later ones', async t => {
  const { jira, tracker, notes } = await trackedSetup(t, 'WEB-1');
  jira.remove('WEB-1'); // the "new site" does not know it
  tracker.credentialsChanged();
  await tracker.testConnection(); // Connect fetches who you are before the check runs
  jira.bulkfetchBody = {};
  assert.equal((await tracker.check()).ok, false); // a failed check does not use up the quiet check
  jira.bulkfetchBody = undefined;
  assert.deepEqual(await tracker.check(), { ok: true, found: 0 });
  const entry = tracker.find('WEB-1');
  assert.equal(entry.error, 'Not found, or no longer accessible');
  assert.deepEqual(entry.changes, []);
  assert.ok(entry.missingSince);
  assert.deepEqual(await tracker.check(), { ok: true, found: 0 });
  assert.deepEqual(entry.changes, []);
  assert.equal(notes.length, 0);

  // Back and gone again: reported as usual
  jira.restore('WEB-1');
  await tracker.check();
  assert.equal(entry.error, null);
  jira.remove('WEB-1');
  assert.deepEqual(await tracker.check(), { ok: true, found: 1 });
});

test('a vanished issue: a failure on another issue in the same check does not hold it back, and loses nothing', async t => {
  const { jira, tracker, notes } = await trackedSetup(t, 'WEB-1', 'WEB-2');
  jira.remove('WEB-1');
  jira.change('WEB-2', { field: 'status', from: 'To Do', to: 'Done', author: jira.people.alex });
  const real = tracker.getClient;
  tracker.getClient = () => ({ ...real(), changelog: async () => { throw Object.assign(new Error('No connection to Jira.'), { code: 'network' }); } });
  assert.equal((await tracker.check()).ok, false);
  const gone = tracker.find('WEB-1');
  assert.deepEqual(gone.changes.map(c => c.field), ['gone']); // reported all the same
  assert.ok(gone.missingSince);
  assert.deepEqual(tracker.find('WEB-2').changes, []); // this one waits
  assert.deepEqual(notes.map(n => n.key), ['WEB-1']);

  tracker.getClient = real;
  assert.deepEqual(await tracker.check(), { ok: true, found: 1 });
  assert.deepEqual(gone.changes.map(c => c.field), ['gone']); // not again
  assert.deepEqual(notes.map(n => n.key), ['WEB-1', 'WEB-2']);
});

test('a vanished issue: a change of account during a check keeps the next check quiet', async t => {
  const { jira, tracker, notes } = await trackedSetup(t, 'WEB-1', 'WEB-2');
  jira.remove('WEB-1');
  jira.remove('WEB-2');
  const real = tracker.getClient;
  tracker.getClient = () => {
    const client = real();
    return { ...client, bulkFetch: async ids => { const res = await client.bulkFetch(ids); tracker.credentialsChanged(); return res; } }; // saved in Settings while the check waits for Jira
  };
  assert.deepEqual(await tracker.check(), { ok: true, found: 0 }); // the old site's answer reports nothing missing
  assert.equal(tracker.find('WEB-1').missingSince, undefined);
  tracker.getClient = real;
  assert.deepEqual(await tracker.check(), { ok: true, found: 0 }); // the first check on the new site is still quiet
  assert.ok(tracker.find('WEB-1').missingSince);
  assert.deepEqual(tracker.find('WEB-1').changes, []);
  assert.equal(notes.length, 0);
});

test('a vanished issue: a second change of account while the check asks who you are keeps the next check quiet', async t => {
  const { jira, tracker, notes } = await trackedSetup(t, 'WEB-1');
  jira.remove('WEB-1');
  tracker.credentialsChanged(); // the URL is saved
  const real = tracker.getClient;
  tracker.getClient = () => {
    const client = real();
    return { ...client, myself: async () => { const me = await client.myself(); tracker.credentialsChanged(); return me; } }; // and the email, while /myself is out
  };
  assert.deepEqual(await tracker.check(), { ok: true, found: 0 });
  assert.equal(tracker.data.me, null); // the old site's answer does not count as who you are
  tracker.getClient = real;
  assert.deepEqual(await tracker.check(), { ok: true, found: 0 });
  assert.ok(tracker.find('WEB-1').missingSince);
  assert.deepEqual(tracker.find('WEB-1').changes, []);
  assert.equal(notes.length, 0);
});

test('a vanished issue: one that was already red before this version stays quiet after the update', async t => {
  const { jira, tracker, store, notes } = await trackedSetup(t, 'WEB-1', 'WEB-2');
  tracker.find('WEB-1').error = 'Not found, or no longer accessible'; // stored by 0.1.2, which had no missingSince
  store.data = ensureShape({ ...JSON.parse(JSON.stringify(store.data)), version: 3 });
  assert.ok(tracker.find('WEB-1').missingSince);
  assert.equal(tracker.find('WEB-2').missingSince, undefined); // healthy entries are left alone
  jira.remove('WEB-1');
  assert.deepEqual(await tracker.check(), { ok: true, found: 0 });
  assert.deepEqual(tracker.find('WEB-1').changes, []);
  assert.equal(notes.length, 0);
});

test('a vanished issue: a failed check and a restart before the next one lose nothing', async t => {
  const { jira, tracker, store, notes } = await trackedSetup(t, 'WEB-1', 'WEB-2');
  jira.remove('WEB-1');
  jira.change('WEB-2', { field: 'status', from: 'To Do', to: 'Done', author: jira.people.alex });
  jira.fail('myself'); // the identity check before reporting WEB-1 fails
  const real = tracker.getClient;
  tracker.getClient = () => ({ ...real(), changelog: async () => { throw Object.assign(new Error('No connection to Jira.'), { code: 'network' }); } });
  assert.equal((await tracker.check()).ok, false);
  assert.ok(tracker.find('WEB-1').error); // red, but not yet recorded as gone
  tracker.getClient = real;
  store.data = ensureShape(JSON.parse(JSON.stringify(store.data))); // the app restarts: only storage from before this version is migrated
  assert.equal(tracker.find('WEB-1').missingSince, undefined);
  assert.deepEqual(await tracker.check(), { ok: true, found: 2 });
  assert.deepEqual(tracker.find('WEB-1').changes.map(c => c.field), ['gone']);
  assert.deepEqual(notes.map(n => n.key).sort(), ['WEB-1', 'WEB-2']);
});

test('moved issue: the key is updated via the id', async t => {
  const { jira, tracker } = await setup(t);
  const issue = jira.addIssue({ key: 'WEB-1', summary: 'x' });
  await tracker.addIssues('WEB-1');
  jira.issues.delete('WEB-1');
  issue.key = 'APP-7';
  jira.issues.set('APP-7', issue);
  await tracker.check();
  assert.ok(tracker.find('APP-7'));
});

test('many changed issues at once give one summary notification', async t => {
  const { jira, tracker, notes } = await setup(t);
  for (let n = 1; n <= 4; n++) jira.addIssue({ key: `WEB-${n}`, summary: `${n}`, updated: Date.now() - DAY });
  await tracker.addIssues('WEB-1 WEB-2 WEB-3 WEB-4');
  for (let n = 1; n <= 4; n++) jira.comment(`WEB-${n}`, 'new');
  await tracker.check();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, '4 issues changed');
  assert.equal(notes[0].key, null);
});

test('notifications off → no notify', async t => {
  const { jira, tracker, notes } = await setup(t, { notify: false });
  jira.addIssue({ key: 'WEB-1', summary: 'x', updated: Date.now() - DAY });
  await tracker.addIssues('WEB-1');
  jira.comment('WEB-1', 'new');
  await tracker.check();
  assert.equal(notes.length, 0);
  assert.equal(tracker.changedCount(), 1);
});

test('the stale list follows the settings', async t => {
  const { jira, tracker } = await setup(t);
  const { me } = jira.people;
  jira.addIssue({ key: 'S-1', summary: '20 days', assignee: me, updated: Date.now() - 20 * DAY });
  jira.addIssue({ key: 'S-2', summary: '10 days', assignee: me, updated: Date.now() - 10 * DAY });
  jira.addIssue({ key: 'S-3', summary: 'backlog', status: 'Backlog', assignee: me, updated: Date.now() - 30 * DAY });
  await tracker.check();
  assert.deepEqual(tracker.data.stale.issues.map(i => i.key), ['S-3', 'S-1']); // no status is excluded by default

  tracker.saveSettings({ staleDays: '7', excluded: 'Backlog' });
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(tracker.data.stale.issues.map(i => i.key), ['S-1', 'S-2']);

  const r = await tracker.track('S-2');
  assert.deepEqual(r.added, ['S-2']);
  assert.equal(tracker.find('S-2').issue.summary, '10 days');
});

test('settings: one settings event with only the keys that really changed', async t => {
  const { tracker } = await setup(t, { defaultProject: 'WEB' });
  const events = [];
  tracker.on('settings', e => events.push(e));

  tracker.saveSettings({ theme: 'dark', staleDays: '7' });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].changed.sort(), ['staleDays', 'theme']);
  assert.equal(events[0].next.theme, 'dark');
  assert.notEqual(events[0].before.theme, 'dark');
  assert.equal(events[0].before.staleDays, 14);

  // Equal after normalising is not changed, and a patch without a change gives no event.
  tracker.saveSettings({ defaultProject: 'web', theme: 'dark', staleDays: 7, excluded: tracker.settings.excluded.join(', ') });
  tracker.saveSettings({ theme: 'onzin', interval: 7, stalePeople: [] });
  tracker.saveSettings({});
  assert.equal(events.length, 1);
});

test('language: system by default, validated, stored, and announced in the settings event', async t => {
  const { tracker, store } = await setup(t);
  const events = [];
  tracker.on('settings', e => events.push(e));
  assert.equal(tracker.settings.language, 'system');
  assert.equal(tracker.t.language, 'en'); // no system locale: English
  assert.equal(tracker.saveSettings({ language: 'nl' }).language, 'nl');
  assert.equal(store.data.settings.language, 'nl');
  assert.equal(tracker.t.language, 'nl');
  assert.deepEqual(events.map(e => e.changed), [['language']]);
  assert.equal(tracker.saveSettings({ language: 'xx' }).language, 'nl'); // unknown value: ignored
  assert.equal(tracker.saveSettings({ language: 'system' }).language, 'system');
  assert.equal(tracker.t.language, 'en');
  assert.equal(events.length, 2);
});

test('language: system follows the locale from env, and reaches the renderer', async t => {
  const { tracker } = await setup(t, {}, { env: { platform: 'darwin', locale: 'nl-NL' } });
  assert.equal(tracker.t.language, 'nl');
  assert.equal(tracker.t.locale, 'nl-NL');
  assert.equal(tracker.publicState().env.locale, 'nl-NL');
  tracker.saveSettings({ language: 'en' });
  assert.equal(tracker.t.locale, 'en-GB');
  const { tracker: stored } = await setup(t, { language: 'nl' }); // a stored choice wins from the start
  assert.equal(stored.t.language, 'nl');
});

test('language: a switch re-words the unconfigured status right away', async t => {
  const { tracker, setToken } = await setup(t);
  setToken(null);
  tracker.start();
  assert.deepEqual(tracker.status, { state: 'unconfigured', message: 'Not connected to Jira yet' });
  tracker.saveSettings({ language: 'nl' });
  assert.deepEqual(tracker.status, { state: 'unconfigured', message: 'Nog niet gekoppeld aan Jira' });
  assert.equal((await tracker.addIssues('WEB-1')).error, 'Koppel eerst je Jira-account in Instellingen.');
});

test('language: a switch while connected checks again soon, so stored texts come back in the new language', async t => {
  const { jira, tracker, timers } = await setup(t);
  jira.addIssue({ key: 'WEB-1', summary: 'x' });
  await tracker.addIssues('WEB-1');
  jira.remove('WEB-1');
  await tracker.check();
  assert.equal(tracker.find('WEB-1').error, 'Not found, or no longer accessible');
  tracker.saveSettings({ language: 'nl' });
  assert.equal(timers.at(-1), 1_000);
  await tracker.check();
  assert.equal(tracker.find('WEB-1').error, 'Niet gevonden of geen toegang meer');
  assert.deepEqual(await tracker.testConnection(), { ok: true, message: 'Verbonden als Demo User' });
});

test('language: a switch after a 429 keeps the Retry-After wait', async t => {
  const { tracker, timers } = await setup(t);
  const rateLimited = Object.assign(new Error('Jira asks you to wait a moment (too many requests).'), { status: 429, code: 'rate_limited', retryAfter: 1_200 });
  tracker.getClient = () => ({ myself: async () => { throw rateLimited; } });
  await tracker.check();
  assert.equal(tracker.status.state, 'error');
  assert.equal(timers.at(-1), 1_200_000); // longer than the interval
  tracker.saveSettings({ language: 'nl' });
  assert.ok(timers.at(-1) > 1_190_000, `next check brought forward to ${timers.at(-1)} ms`);
  assert.ok(tracker.nextCheck - Date.now() > 1_190_000);
});

test('language: a switch during a check re-checks soon after it, and a failed people list is fetched again', async t => {
  const { jira, tracker, timers } = await setup(t);
  await tracker.check();
  jira.usersForbidden = true;
  await tracker.loadPeople({ force: true });
  assert.match(tracker.people.error, /^No access/);
  const running = tracker.check();
  tracker.saveSettings({ language: 'nl' });
  assert.equal(tracker.people.error, null); // reset, so the next loadPeople words the error in Dutch
  await running;
  assert.equal(timers.at(-1), 1_000); // not the regular interval
  assert.equal(tracker.rewordAfterRun, false);
  await tracker.loadPeople();
  assert.match(tracker.people.error, /^Geen toegang/);
});

test('stale: no status is excluded by default, but finished issues never count', async t => {
  const { jira, tracker } = await setup(t);
  const { me } = jira.people;
  jira.addIssue({ key: 'S-1', summary: 'open', assignee: me, updated: Date.now() - 20 * DAY });
  jira.addIssue({ key: 'B-1', summary: 'backlog', status: 'Backlog', assignee: me, updated: Date.now() - 40 * DAY });
  jira.addIssue({ key: 'D-1', summary: 'done', status: 'Done', assignee: me, updated: Date.now() - 50 * DAY });
  jira.addIssue({ key: 'C-1', summary: 'closed', status: 'Closed', assignee: me, updated: Date.now() - 60 * DAY });
  const keys = () => tracker.data.stale.issues.map(i => i.key);
  const settle = () => new Promise(r => setTimeout(r, 100));
  assert.deepEqual(tracker.settings.excluded, []);
  await tracker.check();
  assert.deepEqual(keys(), ['B-1', 'S-1']);
  tracker.saveSettings({ excluded: 'Backlog' });
  await settle();
  assert.deepEqual(keys(), ['S-1']);
  tracker.saveSettings({ excluded: '' });
  await settle();
  assert.deepEqual(keys(), ['B-1', 'S-1']);
});

test('stale: exclude projects by name or key in one field, none by default', async t => {
  const { jira, tracker } = await setup(t);
  const { me } = jira.people;
  const old = Date.now() - 20 * DAY;
  jira.addIssue({ key: 'S-1', summary: 'open', assignee: me, updated: old, project: 'Website' });
  jira.addIssue({ key: 'OLD-1', summary: 'archived', assignee: me, updated: old, project: 'ARCHIVE - Old client' });
  jira.addIssue({ key: 'DEV-1', summary: 'dev', assignee: me, updated: old, project: 'Development' });
  jira.addIssue({ key: 'DEVOPS-1', summary: 'devops', assignee: me, updated: old, project: 'DevOps' });
  jira.addIssue({ key: 'INT-1', summary: 'internal', assignee: me, updated: old, project: 'Internal meeting' });
  const keys = () => tracker.data.stale.issues.map(i => i.key).sort();
  const settle = () => new Promise(r => setTimeout(r, 100));
  assert.deepEqual(tracker.settings.excludedProjects, []);
  await tracker.check();
  assert.deepEqual(keys(), ['DEV-1', 'DEVOPS-1', 'INT-1', 'OLD-1', 'S-1']); // nothing is excluded by default

  assert.deepEqual(tracker.saveSettings({ excludedProjects: ' ARCHIVE*, dev ,' }).excludedProjects, ['ARCHIVE*', 'dev']); // as typed
  await settle();
  assert.deepEqual(keys(), ['DEVOPS-1', 'INT-1', 'S-1']);

  assert.deepEqual(tracker.saveSettings({ excludedProjects: 'ARCHIVE*, DEV, devops, internal *' }).excludedProjects, ['ARCHIVE*', 'DEV', 'devops', 'internal *']);
  await settle();
  assert.deepEqual(keys(), ['S-1']);

  tracker.saveSettings({ excludedProjects: '' }); // empty excludes nothing
  await settle();
  assert.deepEqual(keys(), ['DEV-1', 'DEVOPS-1', 'INT-1', 'OLD-1', 'S-1']);
});

test('stale: saving excludedProjects refreshes the list', async t => {
  const { jira, tracker } = await setup(t);
  await tracker.check();
  const searches = () => jira.requests.filter(r => r.path === '/rest/api/3/search/jql').length;
  const before = searches();
  assert.deepEqual(tracker.saveSettings({ excludedProjects: 'app, ops' }).excludedProjects, ['app', 'ops']);
  await new Promise(r => setTimeout(r, 100));
  assert.ok(searches() > before);
});

test('ensureShape: the old Backlog flag and two project fields are migrated, idempotently', () => {
  const old = settings => ensureShape({ version: 1, settings });
  // Backlog flag on: Backlog is added, unless it is already there (also in other casing)
  assert.deepEqual(old({ excluded: ['Closed', 'On hold'], excludeBacklog: true }).settings.excluded, ['Closed', 'On hold', 'Backlog']);
  assert.deepEqual(old({ excluded: ['Closed', 'backlog'], excludeBacklog: true }).settings.excluded, ['Closed', 'backlog']);
  // Backlog flag off: the list stays as it is
  assert.deepEqual(old({ excluded: ['Closed', 'On hold'], excludeBacklog: false }).settings.excluded, ['Closed', 'On hold']);
  assert.deepEqual(old({ excludeBacklog: true }).settings.excluded, ['Backlog']); // without a stored list: the (empty) default plus Backlog
  assert.deepEqual(old({ excludeBacklog: false }).settings.excluded, []);
  assert.equal('excludeBacklog' in old({ excluded: [], excludeBacklog: true }).settings, false);
  // projects: names, then keys, without duplicates
  const merged = old({ excludedProjectNames: ['ARCHIVE-*', 'Client'], excludedProjectKeys: ['DEV', 'ARCHIVE-*'] });
  assert.deepEqual(merged.settings.excludedProjects, ['ARCHIVE-*', 'Client', 'DEV']);
  assert.equal('excludedProjectNames' in merged.settings, false);
  assert.equal('excludedProjectKeys' in merged.settings, false);
  assert.deepEqual(old({ excludedProjectNames: [], excludedProjectKeys: [] }).settings.excludedProjects, []); // deliberately excluding nothing stays that way
  assert.deepEqual(old({ excludedProjectKeys: ['DEV'] }).settings.excludedProjects, ['DEV']);
  // an existing excludedProjects wins, the old fields disappear
  assert.deepEqual(old({ excludedProjects: ['X'], excludedProjectNames: ['ARCHIVE-*'] }).settings.excludedProjects, ['X']);
  assert.equal(merged.version, 5);
  // fresh install
  const fresh = ensureShape({});
  assert.deepEqual(fresh.settings.excluded, []);
  assert.deepEqual(fresh.settings.excludedProjects, []);
  assert.equal(fresh.settings.notesProject, '');
  assert.equal('excludeBacklog' in fresh.settings, false);
  assert.equal(fresh.version, 5);
  assert.equal(fresh.settings.staleSort, 'oldest');
  // twice gives the same result
  const once = old({ excluded: ['Closed', 'On hold'], excludeBacklog: true, excludedProjectNames: ['ARCHIVE-*'], excludedProjectKeys: ['DEV'] });
  const snapshot = JSON.parse(JSON.stringify(once));
  assert.deepEqual(ensureShape(once), snapshot);
  assert.deepEqual(ensureShape(JSON.parse(JSON.stringify(snapshot))), snapshot);
});

test('ensureShape: a stored URL that is refused now ends up unconfigured, without its token', () => {
  const d = ensureShape({ settings: { baseUrl: 'http://old.atlassian.net', email: 'a@b.c' }, secrets: { token: 'tok' } });
  assert.equal(d.settings.baseUrl, '');
  assert.equal(d.secrets, undefined);
  const ok = ensureShape({ settings: { baseUrl: 'old.atlassian.net/browse/X-1' }, secrets: { token: 'tok' } });
  assert.equal(ok.settings.baseUrl, 'https://old.atlassian.net');
  assert.deepEqual(ok.secrets, { token: 'tok' });
  assert.equal(ensureShape({}).settings.baseUrl, '');
});

test('ensureShape: an unknown language becomes system', () => {
  assert.equal(ensureShape({ settings: { language: 'xx' } }).settings.language, 'system');
  assert.equal(ensureShape({ settings: { language: 42 } }).settings.language, 'system');
  assert.equal(ensureShape({ settings: { language: 'nl' } }).settings.language, 'nl');
  assert.equal(ensureShape({}).settings.language, 'system');
});

test('ensureShape: version 2 → 3 sets staleSort to oldest first, once', () => {
  // a v2 store saved the default 'newest', chosen or not
  const v2 = ensureShape({ version: 2, settings: { staleSort: 'newest' } });
  assert.equal(v2.settings.staleSort, 'oldest');
  assert.equal(v2.version, 5);
  // from v3 on the user's choice counts
  assert.equal(ensureShape({ version: 3, settings: { staleSort: 'newest' } }).settings.staleSort, 'newest');
  assert.equal(ensureShape(JSON.parse(JSON.stringify(v2))).settings.staleSort, 'oldest');
  const chosen = ensureShape({ version: 2, settings: { staleSort: 'newest' } });
  chosen.settings.staleSort = 'newest'; // chosen later
  assert.equal(ensureShape(chosen).settings.staleSort, 'newest'); // and stays that way, even after another ensureShape
});

test('stale: order is configurable, newest or oldest first', async t => {
  const { jira, tracker } = await setup(t);
  const { me } = jira.people;
  jira.addIssue({ key: 'S-1', summary: '20 days', assignee: me, updated: Date.now() - 20 * DAY });
  jira.addIssue({ key: 'S-2', summary: '30 days', assignee: me, updated: Date.now() - 30 * DAY });
  const keys = () => tracker.data.stale.issues.map(i => i.key);
  const jql = () => jira.requests.findLast(r => r.path === '/rest/api/3/search/jql').body.jql;
  assert.equal(tracker.settings.staleSort, 'oldest');
  await tracker.check();
  assert.match(jql(), /ORDER BY updated ASC$/); // with more than 1000 this way the oldest are included
  assert.deepEqual(keys(), ['S-2', 'S-1']);

  assert.equal(tracker.saveSettings({ staleSort: 'newest' }).staleSort, 'newest');
  assert.equal(tracker.saveSettings({ staleSort: 'onzin' }).staleSort, 'newest');
  await tracker.check();
  assert.match(jql(), /ORDER BY updated DESC$/);
  assert.deepEqual(keys(), ['S-1', 'S-2']);
});

test('stale: a status that does not exist in this Jira is skipped with a warning', async t => {
  const { jira, tracker } = await setup(t, { excluded: ['Closed', 'Live'] });
  jira.addIssue({ key: 'S-1', summary: 'open', assignee: jira.people.me, updated: Date.now() - 20 * DAY });
  await tracker.check();
  assert.equal(tracker.data.stale.error, null);
  assert.deepEqual(tracker.data.stale.issues.map(i => i.key), ['S-1']);
  assert.equal(tracker.data.stale.warning, 'Status does not exist in your Jira and was ignored: Live');
});

test('stale: an unknown status with an apostrophe or a backslash is skipped with a warning too', async t => {
  const { jira, tracker } = await setup(t, { excluded: ['Closed'] });
  jira.addIssue({ key: 'S-1', summary: 'open', assignee: jira.people.me, updated: Date.now() - 20 * DAY });
  tracker.saveSettings({ excluded: "Backlog, Won't Fix" });
  await tracker.check();
  assert.equal(tracker.data.stale.error, null);
  assert.deepEqual(tracker.data.stale.issues.map(i => i.key), ['S-1']);
  assert.equal(tracker.data.stale.warning, "Status does not exist in your Jira and was ignored: Won't Fix");

  tracker.saveSettings({ excluded: 'On hold\\, Say "hi", Backlog' });
  await tracker.check();
  assert.equal(tracker.data.stale.error, null);
  assert.equal(tracker.data.stale.warning, 'Statuses do not exist in your Jira and were ignored: On hold\\, Say "hi"');
  assert.deepEqual(tracker.data.stale.issues.map(i => i.key), ['S-1']);
});

test('stale: an unknown status is found in a 400 in another language, by the names that were sent', async t => {
  const { jira, tracker } = await setup(t, { excluded: ['Fix', "Won't Fix", 'Backlog'] });
  jira.unknownStatusText = s => `De waarde '${s}' bestaat niet voor het veld 'status'.`;
  jira.addIssue({ key: 'S-1', summary: 'open', assignee: jira.people.me, updated: Date.now() - 20 * DAY });
  jira.addIssue({ key: 'S-2', summary: 'in Fix', status: 'Fix', assignee: jira.people.me, updated: Date.now() - 20 * DAY });
  await tracker.check();
  assert.equal(tracker.data.stale.error, null);
  assert.deepEqual(tracker.data.stale.issues.map(i => i.key), ['S-1']);
  assert.match(tracker.data.stale.warning, /Won't Fix/);
  const sent = jira.requests.findLast(r => r.path === '/rest/api/3/search/jql').body.jql;
  assert.match(sent, /status NOT IN \("Fix", "Backlog"\)/); // Fix is a status too, and "Fix" in "Won't Fix" does not make it unknown
});

test('stale: in another language only a quoted name in Jira\'s own message is unknown, an unquoted one is not', async t => {
  const { jira, tracker } = await setup(t, { excluded: ['Closed', 'Live', 'Fix'] });
  jira.unknownStatusText = s => `Der Wert ${s} existiert nicht für das Feld status.`;
  jira.addIssue({ key: 'S-1', summary: 'open', assignee: jira.people.me, updated: Date.now() - 20 * DAY });
  tracker.saveSettings({ excluded: 'Closed, Parked' });
  await tracker.check();
  assert.match(tracker.data.stale.error, /Parked/); // no quotes: nothing to go on, so the error stays
  assert.equal(tracker.data.stale.warning, null);
  assert.match(jira.requests.findLast(r => r.path === '/rest/api/3/search/jql').body.jql, /"Closed", "Parked"/);
});

test('stale: the words around Jira\'s message never make an excluded status unknown, in any language', async t => {
  for (const language of ['en', 'nl', 'fr', 'de', 'es']) {
    const catalog = require(`../src/shared/locales/${language}`);
    // every word of IssueMon's own "Jira rejected the request (400, POST …): …" in this language, as a status name
    const words = [...new Set(catalog['error.jira.rejectedDetail'].replace(/\{\w+\}/g, ' ').split(/[^\p{L}]+/u).filter(w => w.length > 2))];
    const { jira, tracker } = await setup(t, { excluded: ['Backlog'], language });
    jira.addIssue({ key: 'S-1', summary: 'open', assignee: jira.people.me, updated: Date.now() - 20 * DAY });
    jira.searchStatus = 400;
    tracker.saveSettings({ excluded: words.join(', ') });
    await tracker.check();
    const searches = jira.requests.filter(r => r.path === '/rest/api/3/search/jql');
    const jql = searches.findLast(() => true).body.jql;
    for (const w of words) assert.ok(jql.includes(`"${w}"`), `${language}: "${w}" is still excluded`);
    assert.equal(tracker.data.stale.warning, null, language);
    assert.match(tracker.data.stale.error, /Mock: search fails/, language);
  }
});

test('stale: a failing request clears the warning of an earlier answer', async t => {
  const { jira, tracker } = await setup(t, { excluded: ['Closed', 'Live'] });
  jira.addIssue({ key: 'S-1', summary: 'open', assignee: jira.people.me, updated: Date.now() - 20 * DAY });
  await tracker.check();
  assert.match(tracker.data.stale.warning, /Live/);
  jira.searchStatus = 400;
  await tracker.check();
  assert.match(tracker.data.stale.error, /400/);
  assert.equal(tracker.data.stale.warning, null);
});

test('stale: several people at once, only you by default', async t => {
  const { jira, tracker } = await setup(t);
  const { me, sam, alex } = jira.people;
  jira.addIssue({ key: 'M-1', summary: 'mine', assignee: me, updated: Date.now() - 20 * DAY });
  jira.addIssue({ key: 'L-1', summary: 'Sam\'s', assignee: sam, updated: Date.now() - 30 * DAY });
  jira.addIssue({ key: 'K-1', summary: 'Alex\'s', assignee: alex, updated: Date.now() - 25 * DAY });
  await tracker.check();
  assert.deepEqual(tracker.data.stale.issues.map(i => i.key), ['M-1']);
  assert.match(jira.requests.findLast(r => r.path === '/rest/api/3/search/jql').body.jql, /^assignee = currentUser\(\)/);

  const s = tracker.saveSettings({ stalePeople: [{ accountId: 'acc-me', name: 'Demo User' }, { accountId: 'acc-sam', name: 'Sam Rivera' }] });
  assert.equal(s.stalePeople.length, 2);
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(tracker.data.stale.issues.map(i => i.key), ['L-1', 'M-1']);

  tracker.saveSettings({ stalePeople: [{ accountId: 'acc-alex', name: 'Alex Morgan' }, { accountId: 'acc-sam', name: 'Sam Rivera' }] });
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(tracker.data.stale.issues.map(i => i.key), ['L-1', 'K-1']);

  // Only yourself is the default, and is stored as such
  assert.deepEqual(tracker.saveSettings({ stalePeople: [{ accountId: 'acc-me', name: 'Demo User' }] }).stalePeople, []);
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(tracker.data.stale.issues.map(i => i.key), ['M-1']);
});

test('stale: a slow older refresh does not overwrite the newest list', async t => {
  const { jira, tracker } = await setup(t);
  const { me, sam } = jira.people;
  jira.addIssue({ key: 'M-1', summary: 'mine', assignee: me, updated: Date.now() - 20 * DAY });
  jira.addIssue({ key: 'L-1', summary: 'Sam\'s', assignee: sam, updated: Date.now() - 30 * DAY });
  await tracker.check();
  assert.deepEqual(tracker.data.stale.issues.map(i => i.key), ['M-1']);

  // The first search (still with only you) comes back last, the second (only Sam) right away.
  const getClient = tracker.getClient;
  let calls = 0;
  tracker.getClient = () => {
    const client = getClient();
    const search = client.search;
    const n = ++calls;
    client.search = async jql => {
      const r = await search(jql);
      if (n === 1) await new Promise(res => setTimeout(res, 150));
      return r;
    };
    return client;
  };
  tracker.saveSettings({ staleDays: '25' });
  tracker.saveSettings({ staleDays: '25', stalePeople: [{ accountId: 'acc-sam', name: 'Sam Rivera' }] });
  await new Promise(r => setTimeout(r, 400));
  assert.equal(calls, 2);
  assert.deepEqual(tracker.data.stale.issues.map(i => i.key), ['L-1']);
});

test('stale: settings refresh during a busy poll, and its older response cannot undo them', { timeout: 5_000 }, async t => {
  const { jira, tracker } = await setup(t);
  const { me, sam } = jira.people;
  jira.addIssue({ key: 'M-1', summary: 'mine, old', assignee: me, updated: Date.now() - 30 * DAY });
  jira.addIssue({ key: 'M-2', summary: 'mine, newer', assignee: me, updated: Date.now() - 16 * DAY });
  jira.addIssue({ key: 'S-1', summary: 'Sam', assignee: sam, updated: Date.now() - 25 * DAY });
  jira.addIssue({ key: 'U-1', summary: 'unassigned', updated: Date.now() - 22 * DAY });
  const keys = () => tracker.publicState().stale.issues.map(i => i.key);
  await tracker.check();
  assert.deepEqual(keys(), ['M-1', 'M-2']);

  // Hold a completed search, so the poll has definitely queried the old settings.
  // No sleeps: subsequent settings refreshes must finish before this response is released.
  const searched = Promise.withResolvers();
  const release = Promise.withResolvers();
  const getClient = tracker.getClient;
  let first = true;
  tracker.getClient = () => {
    const client = getClient();
    const search = client.search;
    client.search = async (...args) => {
      const hold = first;
      first = false;
      const result = await search(...args);
      if (hold) { searched.resolve(); await release.promise; }
      return result;
    };
    return client;
  };
  const polling = tracker.check();
  t.after(async () => { release.resolve(); await polling; });
  await searched.promise;

  const saveAndObserve = async (patch, expected) => {
    const refreshed = Promise.withResolvers();
    const onChange = () => {
      if (JSON.stringify(keys()) === JSON.stringify(expected)) refreshed.resolve();
    };
    tracker.on('change', onChange);
    try {
      tracker.saveSettings(patch);
      await refreshed.promise;
      assert.equal(tracker.running, polling, 'settings refresh finishes while the poll is still busy');
    } finally { tracker.off('change', onChange); }
  };
  await saveAndObserve({ staleDays: 20 }, ['M-1']);
  await saveAndObserve({ stalePeople: [me, sam].map(p => ({ accountId: p.accountId, name: p.displayName })) }, ['M-1', 'S-1']);
  await saveAndObserve({ staleUnassigned: true }, ['M-1', 'S-1', 'U-1']);
  release.resolve();
  assert.equal((await polling).ok, true);
  assert.deepEqual(keys(), ['M-1', 'S-1', 'U-1']);
});

test('stale people are normalised', async t => {
  const { tracker } = await setup(t);
  const s = tracker.saveSettings({ stalePeople: [{ accountId: ' acc-sam ', name: 'Sam' }, { accountId: 'acc-sam', name: 'duplicate' }, { name: 'no id' }, null, { accountId: 'acc-alex' }] });
  assert.deepEqual(s.stalePeople, [{ accountId: 'acc-sam', name: 'Sam' }, { accountId: 'acc-alex', name: 'Unknown' }]);
  assert.deepEqual(tracker.saveSettings({ stalePeople: 'onzin' }).stalePeople, []);
});

test('stale filter: stored, normalised and without a new stale request', async t => {
  const { jira, tracker, store } = await setup(t);
  assert.deepEqual(tracker.settings.staleFilter, []);
  const requests = () => jira.requests.filter(r => r.path === '/rest/api/3/search/jql').length;
  const before = requests();
  const s = tracker.saveSettings({ staleFilter: [' acc-sam ', 'acc-sam', '', null, 'acc-alex', 42] });
  assert.deepEqual(s.staleFilter, ['acc-sam', 'acc-alex', '42']);
  assert.deepEqual(store.data.settings.staleFilter, ['acc-sam', 'acc-alex', '42']);
  assert.ok(store.saves > 0);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(requests(), before); // the filter is display only
  assert.deepEqual(tracker.saveSettings({ theme: 'dark' }).staleFilter, ['acc-sam', 'acc-alex', '42']); // other settings leave it in place
  assert.deepEqual(tracker.saveSettings({ staleFilter: 'onzin' }).staleFilter, []);
  assert.deepEqual(ensureShape({ settings: { staleFilter: ['acc-sam'] } }).settings.staleFilter, ['acc-sam']); // also from the store
  assert.deepEqual(ensureShape({ settings: { staleFilter: 'acc-sam' } }).settings.staleFilter, []); // mangled by hand
});

test('stale: issues without an assignee too, as a setting of its own', async t => {
  const { jira, tracker, store } = await setup(t);
  const { me } = jira.people;
  jira.addIssue({ key: 'M-1', summary: 'mine', assignee: me, updated: Date.now() - 20 * DAY });
  jira.addIssue({ key: 'U-1', summary: 'unassigned', updated: Date.now() - 30 * DAY });
  jira.addIssue({ key: 'U-2', summary: 'unassigned, but recent', updated: Date.now() - 2 * DAY });
  await tracker.check();
  assert.deepEqual(tracker.data.stale.issues.map(i => i.key), ['M-1']);
  const jql = () => jira.requests.findLast(r => r.path === '/rest/api/3/search/jql').body.jql;

  const s = tracker.saveSettings({ staleUnassigned: 'yes' }); // stored as a boolean, whatever comes in
  assert.equal(s.staleUnassigned, true);
  assert.equal(store.data.settings.staleUnassigned, true);
  await new Promise(r => setTimeout(r, 100));
  assert.match(jql(), /^\(assignee = currentUser\(\) OR assignee IS EMPTY\) AND /);
  assert.deepEqual(tracker.data.stale.issues.map(i => i.key), ['U-1', 'M-1']);

  tracker.saveSettings({ stalePeople: [{ accountId: 'acc-sam', name: 'Sam Rivera' }] });
  await new Promise(r => setTimeout(r, 100));
  assert.match(jql(), /^\(assignee IN \("acc-sam"\) OR assignee IS EMPTY\) AND /);
  assert.deepEqual(tracker.data.stale.issues.map(i => i.key), ['U-1']);

  assert.equal(tracker.saveSettings({ staleUnassigned: false }).staleUnassigned, false);
  await new Promise(r => setTimeout(r, 100));
  assert.match(jql(), /^assignee IN \("acc-sam"\) AND /);
  assert.deepEqual(tracker.data.stale.issues.map(i => i.key), []);
  assert.equal(ensureShape({ settings: {} }).settings.staleUnassigned, false); // off by default, also for older storage
});

test('loading colleagues: cached, reloaded on request, error visible', async t => {
  let now = Date.now();
  const { jira, tracker, setToken } = await setup(t);
  tracker.now = () => now;
  const calls = () => jira.requests.filter(r => r.path === '/rest/api/3/users/search' && r.query.startAt === '0').length; // times loaded

  const p = await tracker.loadPeople();
  assert.deepEqual(p.list.map(x => x.accountId), ['acc-alex', 'acc-me', 'acc-jordan', 'acc-priya', 'acc-sam']);
  assert.equal(tracker.data.me.accountId, 'acc-me'); // needed to point out yourself
  assert.equal(tracker.publicState().people.list.length, 5);
  assert.equal(calls(), 1);

  await tracker.loadPeople();
  assert.equal(calls(), 1); // within the hour from the cache
  now += 61 * 60_000;
  await tracker.loadPeople();
  assert.equal(calls(), 2);
  await tracker.loadPeople({ force: true });
  assert.equal(calls(), 3);

  jira.usersForbidden = true;
  const failed = await tracker.loadPeople({ force: true });
  assert.match(failed.error, /^No access/);
  assert.equal(failed.list.length, 5); // the previous list stays
  jira.usersForbidden = false;
  assert.equal((await tracker.loadPeople()).error, null); // after an error always try again

  tracker.saveSettings({ email: 'other@example.com' }); // different account: list gone
  assert.deepEqual(tracker.people.list, []);
  setToken(null);
  assert.deepEqual((await tracker.loadPeople()).list, []);
});

test('wrong login: status error and next check scheduled', async t => {
  const { tracker, setToken, timers } = await setup(t);
  setToken('wrong');
  const r = await tracker.check();
  assert.equal(r.ok, false);
  assert.equal(tracker.status.state, 'error');
  assert.match(tracker.status.message, /^Login failed/);
  assert.equal(timers.at(-1), 10 * 60_000);
});

test('Jira unreachable: quick retries with backoff, then the interval again', async t => {
  const { jira, tracker, timers } = await setup(t);
  const port = new URL(jira.url).port;
  await jira.stop();
  const r = await tracker.check();
  assert.equal(r.ok, false);
  assert.equal(tracker.status.state, 'error');
  assert.equal(tracker.status.code, 'network');
  assert.equal(timers.at(-1), 30_000);
  await tracker.check();
  assert.equal(timers.at(-1), 60_000);
  for (const ms of [120_000, 300_000, 300_000]) {
    await tracker.check();
    assert.equal(timers.at(-1), ms);
  }
  await jira.start(Number(port));
  assert.equal((await tracker.check()).ok, true);
  assert.equal(timers.at(-1), 10 * 60_000);
  await jira.stop();
  await tracker.check();
  assert.equal(timers.at(-1), 30_000); // counter has been reset
});

test('a login error keeps the regular interval, without backoff', async t => {
  const { tracker, timers, setToken } = await setup(t, { interval: 5 });
  setToken('wrong');
  await tracker.check();
  assert.equal(tracker.status.code, 'auth');
  assert.equal(timers.at(-1), 5 * 60_000);
});

test('notes: add, edit, remove and restore', async t => {
  const { tracker, store } = await setup(t);
  assert.equal(tracker.addNote('   '), null);
  const a = tracker.addNote('  Cookie banner   covers\nthe footer ');
  assert.equal(a.text, 'Cookie banner covers the footer');
  const b = tracker.addNote('Typo on the contact page');
  assert.deepEqual(tracker.publicState().notes.map(n => n.text), ['Typo on the contact page', 'Cookie banner covers the footer']);

  assert.equal(tracker.editNote(a.id, 'Cookie banner on mobile'), true);
  assert.equal(tracker.editNote(a.id, ' \n '), false); // empty: the old text stays
  assert.equal(tracker.findNote(a.id).text, 'Cookie banner on mobile');
  assert.equal(tracker.editNote('does-not-exist', 'x'), false);
  assert.equal(tracker.addNote('x'.repeat(300)).text.length, 255);

  assert.equal(tracker.removeNote(b.id), true);
  assert.equal(tracker.findNote(b.id), undefined);
  assert.equal(tracker.restoreNote(b.id), true);
  assert.equal(tracker.data.notes.indexOf(tracker.findNote(b.id)), 1); // back in its old place
  assert.ok(store.saves > 0);
});

test('ticking off notes and turning them back on', async t => {
  const { tracker, store } = await setup(t);
  const a = tracker.addNote('Cookie banner');
  const saves = store.saves;
  assert.equal(tracker.setNoteDone(a.id, true), true);
  assert.equal(tracker.findNote(a.id).done, true);
  assert.equal(typeof tracker.findNote(a.id).doneAt, 'number');
  assert.ok(store.saves > saves);
  assert.equal(tracker.setNoteDone(a.id, false), true);
  assert.equal(tracker.findNote(a.id).done, undefined);
  assert.equal(tracker.findNote(a.id).doneAt, undefined);
  assert.equal(tracker.setNoteDone('does-not-exist', true), false);
  tracker.findNote(a.id).creating = true; // is just becoming an issue: cannot be changed
  assert.equal(tracker.setNoteDone(a.id, true), false);
});

test('moving notes', async t => {
  const { tracker } = await setup(t);
  for (const text of ['d', 'c', 'b', 'a']) tracker.addNote(text); // newest at the top: a b c d
  const texts = () => tracker.data.notes.map(n => n.text);
  const id = text => tracker.data.notes.find(n => n.text === text).id;
  assert.equal(tracker.moveNote(id('a'), 2), true);
  assert.deepEqual(texts(), ['b', 'c', 'a', 'd']);
  tracker.moveNote(id('d'), 0);
  assert.deepEqual(texts(), ['d', 'b', 'c', 'a']);
  tracker.moveNote(id('b'), 99); // outside the list: to the edge
  assert.deepEqual(texts(), ['d', 'c', 'a', 'b']);
  tracker.moveNote(id('a'), -1);
  assert.deepEqual(texts(), ['a', 'd', 'c', 'b']);
  assert.equal(tracker.moveNote('does-not-exist', 0), false);
});

test('notes from the store: a half-finished creation is reset and broken items are dropped', () => {
  const d = ensureShape({ notes: [{ id: 'a', text: 'x', createdAt: 1, creating: true }, { id: 'b' }, null] });
  assert.deepEqual(d.notes, [{ id: 'a', text: 'x', createdAt: 1 }]);
  assert.deepEqual(ensureShape({}).notes, []);
});

test('issue from a note: in the notes project, then tracked', async t => {
  const { jira, tracker } = await setup(t, { notesProject: 'OPS' });
  const note = tracker.addNote('Cookie banner covers the footer');
  const r = await tracker.createIssueFromNote(note.id);
  assert.deepEqual(r, { ok: true, key: 'OPS-1', tracked: true });
  assert.equal(jira.issues.get('OPS-1').fields.summary, 'Cookie banner covers the footer');
  assert.equal(jira.issues.get('OPS-1').fields.type, 'Task');
  assert.equal(tracker.findNote(note.id), undefined);
  assert.equal(tracker.find('OPS-1').issue.summary, 'Cookie banner covers the footer');

  // What happens in Jira afterwards comes in as a change.
  jira.comment('OPS-1', 'Picked up', jira.people.alex, Date.now() + 1000);
  assert.deepEqual(await tracker.check(), { ok: true, found: 1 });
  assert.equal(tracker.changedCount(), 1);
});

test('issue from a note with its own title, project and type', async t => {
  const { jira, tracker } = await setup(t);
  jira.addIssue({ key: 'WEB-1', summary: 'Existing' }); // makes project WEB known
  const note = tracker.addNote('Cookie banner covers the footer');
  const r = await tracker.createIssueFromNote(note.id, { summary: '  Other   title ', project: 'web', typeId: '10003' });
  assert.deepEqual(r, { ok: true, key: 'WEB-2', tracked: true });
  const post = jira.requests.filter(q => q.method === 'POST' && q.path === '/rest/api/3/issue').at(-1);
  assert.deepEqual(post.body, { fields: { project: { key: 'WEB' }, issuetype: { id: '10003' }, summary: 'Other title' } });
  assert.equal(jira.issues.get('WEB-2').fields.type, 'Bug');
  assert.equal(tracker.findNote(note.id), undefined);
  assert.ok(tracker.find('WEB-2'));
});

test('issue from a note with an assignee and a description', async t => {
  const { jira, tracker } = await setup(t);
  jira.addIssue({ key: 'WEB-1', summary: 'Existing' });
  const note = tracker.addNote('Cookie banner covers the footer');
  const r = await tracker.createIssueFromNote(note.id, { project: 'WEB', assignee: 'acc-alex', description: 'Only on mobile.\nSafari too.' });
  assert.deepEqual(r, { ok: true, key: 'WEB-2', tracked: true });
  const post = jira.requests.filter(q => q.method === 'POST' && q.path === '/rest/api/3/issue').at(-1);
  assert.deepEqual(post.body.fields.assignee, { accountId: 'acc-alex' });
  assert.deepEqual(post.body.fields.description.content.map(p => p.content[0].text), ['Only on mobile.', 'Safari too.']);
  assert.equal(tracker.find('WEB-2').issue.assignee.name, 'Alex Morgan');
});

test('issue from a note: an assignee Jira doesn\'t know gives an error, the note stays', async t => {
  const { jira, tracker } = await setup(t);
  jira.addIssue({ key: 'WEB-1', summary: 'Existing' });
  const note = tracker.addNote('Something');
  const r = await tracker.createIssueFromNote(note.id, { project: 'WEB', assignee: 'acc-gone' });
  assert.equal(r.ok, false);
  assert.match(r.error, /acc-gone/);
  assert.ok(tracker.findNote(note.id));
});

test('issue from a note with an empty title: error, the note stays', async t => {
  const { jira, tracker } = await setup(t);
  const note = tracker.addNote('Something');
  const r = await tracker.createIssueFromNote(note.id, { summary: '   ' });
  assert.deepEqual(r, { ok: false, error: 'Give the issue a title.' });
  assert.ok(tracker.findNote(note.id));
  assert.equal(jira.requests.some(q => q.method === 'POST' && q.path === '/rest/api/3/issue'), false);
});

test('issue types are cached per project; an error is not cached', async t => {
  const { jira, tracker } = await setup(t);
  const metaCalls = () => jira.requests.filter(q => q.path.includes('/createmeta/')).length;
  const first = await tracker.issueTypes('ops');
  assert.deepEqual(first, { ok: true, types: [{ id: '10001', name: 'Story' }, { id: '10002', name: 'Task' }, { id: '10003', name: 'Bug' }] });
  assert.equal(metaCalls(), 1);
  assert.deepEqual(await tracker.issueTypes('OPS'), first);
  assert.equal(metaCalls(), 1);
  const missing = await tracker.issueTypes('NOPE');
  assert.equal(missing.ok, false);
  assert.match(missing.error, /Project NOPE does not exist/);
  assert.equal(metaCalls(), 2);
  await tracker.issueTypes('NOPE'); // an error is not remembered
  assert.equal(metaCalls(), 3);
});

test('activity gives the newest comment and change, and remembers them for ten minutes', async t => {
  const { jira, tracker } = await setup(t);
  const { alex, sam, priya } = jira.people;
  const now = Date.now();
  jira.addIssue({ key: 'WEB-1', summary: 'One', updated: now - DAY });
  jira.change('WEB-1', { field: 'status', from: 'To Do', to: 'In Progress', author: alex, at: now - 5 * DAY });
  jira.change('WEB-1', { field: 'assignee', from: 'Alex Morgan', to: 'Sam Rivera', author: sam, at: now - 3 * DAY });
  jira.comment('WEB-1', 'First reply', alex, now - 4 * DAY);
  jira.comment('WEB-1', 'Last comment', priya, now - 2 * DAY);
  const calls = () => jira.requests.filter(q => /\/(comment|changelog)$/.test(q.path)).length;

  const r = await tracker.activity('WEB-1');
  assert.equal(r.ok, true);
  assert.deepEqual(r.comment.author, { accountId: 'acc-priya', name: 'Priya Patel' });
  assert.equal(r.comment.text, 'Last comment');
  assert.equal(r.comment.at, now - 2 * DAY);
  assert.equal(r.change.field, 'assignee');
  assert.equal(r.change.label, 'assignee');
  assert.deepEqual([r.change.from, r.change.to, r.change.author.name], ['Alex Morgan', 'Sam Rivera', 'Sam Rivera']);
  assert.equal(typeof r.fetchedAt, 'number');
  assert.equal(calls(), 2);

  assert.deepEqual(await tracker.activity('WEB-1'), r); // from the cache
  assert.equal(calls(), 2);

  const at = tracker.now();
  tracker.now = () => at + 11 * 60_000; // fetch again after ten minutes
  await tracker.activity('WEB-1');
  assert.equal(calls(), 4);
});

test('activity: new changes in a check invalidate the cache, a different account clears it', async t => {
  const { jira, tracker } = await setup(t);
  const { alex } = jira.people;
  jira.addIssue({ key: 'WEB-1', summary: 'One', updated: Date.now() - DAY });
  jira.addIssue({ key: 'WEB-2', summary: 'Two', updated: Date.now() - DAY });
  await tracker.addIssues('WEB-1 WEB-2');
  const calls = () => jira.requests.filter(q => /\/(comment|changelog)$/.test(q.path)).length;

  await tracker.activity('WEB-1');
  await tracker.activity('WEB-2');
  const base = calls();
  jira.comment('WEB-1', 'New', alex);
  await tracker.check();
  const afterCheck = calls();
  const r = await tracker.activity('WEB-1');
  assert.equal(r.comment.text, 'New');
  assert.equal(calls(), afterCheck + 2); // WEB-1 fetched again
  await tracker.activity('WEB-2');
  assert.equal(calls(), afterCheck + 2); // WEB-2 still from the cache
  assert.ok(base < afterCheck);

  tracker.saveSettings({ email: 'other@example.com' });
  assert.equal(tracker.activityCache.size, 0);
  assert.equal(tracker.typeCache.size, 0);
});

test('remember keeps a cache at 200 items, dropping the oldest', async t => {
  const { tracker } = await setup(t);
  for (let i = 0; i < 250; i++) tracker.remember(tracker.activityCache, `WEB-${i}`, { at: 0 });
  assert.equal(tracker.activityCache.size, 200);
  assert.equal(tracker.activityCache.has('WEB-0'), false);
  assert.equal(tracker.activityCache.has('WEB-249'), true);
});

test('activity without comments or changes, and with an unknown key', async t => {
  const { jira, tracker } = await setup(t);
  jira.addIssue({ key: 'WEB-2', summary: 'Two' });
  const r = await tracker.activity('WEB-2');
  assert.equal(r.ok, true);
  assert.equal(r.comment, null);
  assert.equal(r.change, null);
  const missing = await tracker.activity('WEB-404');
  assert.equal(missing.ok, false);
  assert.equal(typeof missing.error, 'string');
});

test('activity remembers a failed attempt for thirty seconds, and a check or a different account clears it too', async t => {
  const { jira, tracker } = await setup(t);
  const { alex } = jira.people;
  const calls = () => jira.requests.filter(q => /\/(comment|changelog)$/.test(q.path)).length;

  const first = await tracker.activity('WEB-404');
  assert.equal(first.ok, false);
  assert.equal(typeof first.fetchedAt, 'number');
  const made = calls();
  assert.ok(made > 0);
  assert.deepEqual(await tracker.activity('WEB-404'), first); // from the cache
  assert.equal(calls(), made);

  // A check with new changes clears a cached error.
  jira.addIssue({ key: 'WEB-1', summary: 'One', updated: Date.now() - DAY });
  await tracker.addIssues('WEB-1');
  const issue = jira.issues.get('WEB-1');
  jira.remove('WEB-1'); // temporarily unreachable: the attempt fails
  assert.equal((await tracker.activity('WEB-1')).ok, false);
  jira.issues.set('WEB-1', issue);
  assert.equal((await tracker.activity('WEB-1')).ok, false); // still the cached error
  jira.comment('WEB-1', 'New', alex);
  await tracker.check();
  const r = await tracker.activity('WEB-1');
  assert.equal(r.ok, true);
  assert.equal(r.comment.text, 'New');

  // A different account also clears a cached error.
  await tracker.activity('WEB-405');
  assert.equal(tracker.activityCache.get('WEB-405').result.ok, false);
  tracker.saveSettings({ email: 'other@example.com' });
  assert.equal(tracker.activityCache.size, 0);

  // After thirty seconds it tries again.
  await tracker.activity('WEB-404');
  const before = calls();
  const at = tracker.now();
  tracker.now = () => at + 31e3;
  const second = await tracker.activity('WEB-404');
  assert.ok(calls() > before);
  assert.equal(second.fetchedAt, at + 31e3);
});

test('issue from a note: clicking twice gives one issue', async t => {
  const { jira, tracker } = await setup(t, { notesProject: 'OPS' });
  const note = tracker.addNote('Eén keer');
  const [first, second] = await Promise.all([tracker.createIssueFromNote(note.id), tracker.createIssueFromNote(note.id)]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.deepEqual([...jira.issues.keys()], ['OPS-1']);
});

test('issue from a note: without a notes project the default project is used', async t => {
  const { jira, tracker } = await setup(t, { defaultProject: 'WEB' });
  assert.equal(tracker.settings.notesProject, '');
  const note = tracker.addNote('Fallback');
  assert.deepEqual(await tracker.createIssueFromNote(note.id), { ok: true, key: 'WEB-1', tracked: true });
  assert.ok(jira.issues.has('WEB-1'));
  assert.deepEqual((await tracker.issueTypes('')).ok, true); // the issue types of the panel follow the same fallback
  // an explicit notes project wins, and an explicit project in the panel wins over both
  tracker.saveSettings({ notesProject: 'OPS' });
  assert.equal((await tracker.createIssueFromNote(tracker.addNote('Notes project').id)).key, 'OPS-1');
  assert.equal((await tracker.createIssueFromNote(tracker.addNote('Panel').id, { project: 'web' })).key, 'WEB-2');
});

test('issue from a note: neither a notes project nor a default project asks for one', async t => {
  const { jira, tracker } = await setup(t);
  const note = tracker.addNote('Nowhere');
  assert.deepEqual(await tracker.createIssueFromNote(note.id), { ok: false, error: 'Set a project for new issues in Settings first.' });
  assert.equal(jira.requests.some(q => q.method === 'POST' && q.path === '/rest/api/3/issue'), false);
  assert.ok(tracker.findNote(note.id));
});

test('issue from a note fails: the note stays', async t => {
  const { tracker, setToken } = await setup(t, { notesProject: 'NOPE' });
  const note = tracker.addNote('Something');
  const r = await tracker.createIssueFromNote(note.id);
  assert.equal(r.ok, false);
  assert.match(r.error, /Project NOPE does not exist/);
  assert.equal(tracker.findNote(note.id).creating, undefined);
  assert.equal(tracker.data.tracked.length, 0);

  tracker.saveSettings({ notesProject: '' });
  assert.equal((await tracker.createIssueFromNote(note.id)).error, 'Set a project for new issues in Settings first.');
  tracker.saveSettings({ notesProject: 'OPS' });
  setToken(null);
  assert.equal((await tracker.createIssueFromNote(note.id)).error, 'Connect your Jira account in Settings first.');
  assert.ok(tracker.findNote(note.id));
});

test('a changed Jira host clears the stored token and shows the disconnected state', async t => {
  const { tracker, store } = await setup(t, { baseUrl: 'https://old.atlassian.net' });
  assert.equal(tracker.publicState().settings.hasToken, true);
  const s = tracker.saveSettings({ baseUrl: 'https://other.atlassian.net' });
  assert.equal(s.baseUrl, 'https://other.atlassian.net');
  assert.equal(tracker.publicState().settings.hasToken, false);
  assert.equal(tracker.configured(), false);
  assert.equal(tracker.status.state, 'unconfigured');
  assert.ok(store.saves > 0);
});

test('a refused URL (plain http to a non-local host) keeps the stored URL and token and says so', async t => {
  const { tracker } = await setup(t, { baseUrl: 'https://old.atlassian.net' });
  const s = tracker.saveSettings({ baseUrl: 'http://old.atlassian.net' });
  assert.equal(s.urlRefused, true);
  assert.equal(s.baseUrl, 'https://old.atlassian.net');
  assert.equal(tracker.settings.baseUrl, 'https://old.atlassian.net');
  assert.equal(tracker.publicState().settings.hasToken, true);
  assert.equal('urlRefused' in tracker.publicState().settings, false);
  assert.equal(tracker.saveSettings({ baseUrl: 'https://old.atlassian.net' }).urlRefused, undefined);
});

test('an emptied URL field still clears the URL and the token', async t => {
  const { tracker } = await setup(t, { baseUrl: 'https://old.atlassian.net' });
  const s = tracker.saveSettings({ baseUrl: '  ' });
  assert.equal(s.baseUrl, '');
  assert.equal(s.urlRefused, undefined);
  assert.equal(tracker.publicState().settings.hasToken, false);
});

test('a refused URL followed by another valid host still ends with a cleared token', async t => {
  const { tracker } = await setup(t, { baseUrl: 'https://old.atlassian.net' });
  tracker.saveSettings({ baseUrl: 'http://evil.example' });
  tracker.saveSettings({ baseUrl: 'https://evil.example' });
  assert.equal(tracker.publicState().settings.hasToken, false);
});

test('the same host keeps the token: other path, case, scheme or whitespace', async t => {
  const { tracker } = await setup(t, { baseUrl: 'https://old.atlassian.net' });
  for (const url of ['OLD.atlassian.net/browse/WEB-1', ' https://Old.Atlassian.net/ ', 'https://old.atlassian.net/jira/software']) {
    assert.equal(tracker.saveSettings({ baseUrl: url }).baseUrl, 'https://old.atlassian.net');
    assert.equal(tracker.publicState().settings.hasToken, true, url);
  }
});

test('other settings and an email change keep the token', async t => {
  const { tracker } = await setup(t, { baseUrl: 'https://old.atlassian.net' });
  tracker.saveSettings({ theme: 'dark', email: 'new@example.com' });
  assert.equal(tracker.publicState().settings.hasToken, true);
});

test('a patch with a new URL and a token keeps (and replaces) the token', async t => {
  const { tracker } = await setup(t, { baseUrl: 'https://old.atlassian.net' });
  tracker.saveSettings({ baseUrl: 'https://other.atlassian.net', token: ' new ' });
  assert.equal(tracker.publicState().settings.hasToken, true);
  assert.equal('token' in tracker.settings, false); // never stored in the settings
});

test('first run: no URL yet, then URL and token together', async t => {
  const { tracker, setToken } = await setup(t, { baseUrl: '' });
  setToken(null);
  tracker.saveSettings({ baseUrl: 'https://new.atlassian.net', email: 'user@example.com', token: 'tok' });
  assert.equal(tracker.publicState().settings.hasToken, true);
});

test('a token entered before any URL survives the first URL', async t => {
  const { tracker } = await setup(t, { baseUrl: '' });
  tracker.saveSettings({ baseUrl: 'https://new.atlassian.net' });
  assert.equal(tracker.publicState().settings.hasToken, true);
});

test('settings are normalised', async t => {
  const { tracker } = await setup(t);
  assert.equal(tracker.settings.notesProject, '');
  const s = tracker.saveSettings({ baseUrl: 'example.atlassian.net/browse/X-1', defaultProject: ' web ', notesProject: ' o-ps ', interval: '7', staleDays: '0', excluded: 'Closed, , Backlog' });
  assert.equal(s.baseUrl, 'https://example.atlassian.net');
  assert.equal(s.defaultProject, 'WEB');
  assert.equal(s.notesProject, 'OPS');
  assert.equal(s.interval, 10); // 7 is not a valid choice
  assert.equal(s.staleDays, 14); // 0 is invalid → old value
  assert.deepEqual(s.excluded, ['Closed', 'Backlog']);
  assert.equal(s.theme, 'system');
  assert.equal(tracker.saveSettings({ theme: 'dark' }).theme, 'dark');
  assert.equal(tracker.saveSettings({ theme: 'paars' }).theme, 'dark'); // invalid → unchanged
  assert.equal(tracker.publicState().settings.hasToken, false); // the URL above is another host than the one the token was entered for
  assert.equal('secrets' in tracker.publicState(), false);
});

test('checkUpdates: on by default, stored as a boolean, and announced in the settings event', async t => {
  const { tracker, store } = await setup(t);
  const events = [];
  tracker.on('settings', e => events.push(e));
  assert.equal(tracker.settings.checkUpdates, true);
  assert.equal(ensureShape({}).settings.checkUpdates, true);
  assert.equal(ensureShape({ settings: { checkUpdates: false } }).settings.checkUpdates, false); // an older file without it gets the default; one with it keeps it
  assert.equal(tracker.saveSettings({ checkUpdates: false }).checkUpdates, false);
  assert.equal(store.data.settings.checkUpdates, false);
  assert.deepEqual(events.map(e => e.changed), [['checkUpdates']]);
  assert.equal(tracker.saveSettings({ checkUpdates: 1 }).checkUpdates, true);
  assert.equal(tracker.saveSettings({ checkUpdates: '' }).checkUpdates, false);
  tracker.saveSettings({ theme: 'dark' }); // other settings leave it alone
  assert.equal(tracker.settings.checkUpdates, false);
});

test('ensureShape: the update state has a shape of its own and survives a restart', () => {
  assert.deepEqual(ensureShape({}).updates, { lastCheck: null, latest: null, url: null, dismissed: null });
  const stored = { lastCheck: 5, latest: '0.2.0', url: 'https://github.com/fundament-agency/issuemon/releases/tag/v0.2.0', dismissed: '0.2.0' };
  assert.deepEqual(ensureShape({ updates: stored }).updates, stored);
  assert.deepEqual(ensureShape({ updates: { latest: '0.2.0' } }).updates, { lastCheck: null, latest: '0.2.0', url: null, dismissed: null });
  assert.deepEqual(ensureShape({ updates: 'garbage' }).updates, { lastCheck: null, latest: null, url: null, dismissed: null });
});

test('updates: the state is stored, pushed to the renderer with the version, and newer is worked out', async t => {
  const { tracker, store } = await setup(t);
  tracker.version = '0.1.0';
  let pushes = 0;
  tracker.on('change', () => pushes++);
  assert.equal(tracker.publicState().version, '0.1.0');
  assert.deepEqual(tracker.publicState().updates, { lastCheck: null, latest: null, url: null, dismissed: null, newer: false });

  tracker.setUpdates({ lastCheck: 7, latest: '0.2.0', url: 'u' });
  assert.equal(pushes, 1);
  assert.ok(store.saves > 0);
  assert.deepEqual(store.data.updates, { lastCheck: 7, latest: '0.2.0', url: 'u', dismissed: null });
  assert.equal(tracker.publicState().updates.newer, true);

  tracker.setUpdates({ dismissed: '0.2.0' }); // dismissed stays available: the Settings line still shows the version
  assert.equal(tracker.publicState().updates.newer, true);
  assert.equal(tracker.publicState().updates.dismissed, '0.2.0');

  tracker.setUpdates({ latest: '0.1.0' });
  assert.equal(tracker.publicState().updates.newer, false);
  tracker.version = '0.3.0'; // the app was updated: no longer newer
  tracker.setUpdates({ latest: '0.2.0' });
  assert.equal(tracker.publicState().updates.newer, false);
});

test('updates: checkUpdates is a manual check by the update checker, dismissUpdate is its dismiss', async t => {
  const { tracker } = await setup(t);
  assert.deepEqual(await tracker.checkUpdates(), { ok: false }); // no checker: no answer, no throw
  assert.equal(tracker.dismissUpdate(), true);
  const calls = [];
  tracker.updateChecker = {
    check: async o => { calls.push(['check', o]); return { ok: true, latest: '0.2.0', url: 'u', newer: true }; },
    dismiss: () => calls.push(['dismiss']),
  };
  assert.deepEqual(await tracker.checkUpdates(), { ok: true, latest: '0.2.0', url: 'u', newer: true });
  assert.equal(tracker.dismissUpdate(), true);
  assert.deepEqual(calls, [['check', { manual: true }], ['dismiss']]);
});

test('comment mentions use account ids on new and edited records and retain own-change suppression', async t => {
  const { jira, tracker, notes, store } = await setup(t);
  const { me, sam } = jira.people;
  const now = Date.now();
  jira.addIssue({ key: 'WEB-1', summary: 'Mentions', updated: now - DAY });
  await tracker.addIssues('WEB-1');
  await tracker.check();
  const id = jira.comment('WEB-1', 'Please review', sam, now, [me]).comments[0].id;
  await tracker.check();
  const entry = tracker.find('WEB-1');
  assert.equal(entry.changes[0].mentionsMe, true);
  assert.equal(store.data.tracked[0].changes[0].mentions[0].accountId, me.accountId);
  assert.deepEqual(notes.pop(), { title: 'WEB-1 mentions you', subtitle: 'Mentions', body: 'Sam Rivera mentioned you on WEB-1', key: 'WEB-1' });
  assert.equal((await tracker.check()).found, 0);

  // Same display text, another account: the edit is real, but does not address me.
  jira.editComment('WEB-1', id, 'Please review', sam, now + 1000, [{ ...me, accountId: 'someone-else' }]);
  await tracker.check();
  assert.equal(entry.changes.at(-1).edited, true);
  assert.ok(!entry.changes.at(-1).mentionsMe);
  assert.match(notes.pop().body, /edited a comment/);
  jira.editComment('WEB-1', id, 'Please review', sam, now + 2000, [me]);
  await tracker.check();
  assert.equal(entry.changes.at(-1).mentionsMe, true);
  assert.equal(notes.pop().body, 'Sam Rivera mentioned you on WEB-1');

  jira.comment('WEB-1', 'My own mention', me, now + 3000, [me]);
  await tracker.check();
  assert.deepEqual([entry.changes.at(-1).mentionsMe, entry.changes.at(-1).own, entry.changes.at(-1).processed], [true, true, true]);
  assert.equal(notes.length, 0);
  // A legacy record has no mention metadata and remains a safe text baseline.
  delete entry.changes.at(-1).mentions;
  assert.equal(tracker.commentTexts(entry).get(entry.changes.at(-1).id.slice(1)).text, 'My own mention @Demo User');
});

test('summary counts issues per kind, overlaps included, and ranks keys without mutating fresh changes', async t => {
  const { tracker, notes } = await setup(t);
  tracker.data.me = { name: 'Demo User' };
  const assignment = { field: 'assignee', to: 'Demo User', at: 1 };
  const mention = { field: 'comment', mentionsMe: true, at: 2 };
  const fresh = [
    { key: 'WEB-1', changes: [{ field: 'comment', at: 100 }] },
    { key: 'WEB-2', changes: [mention, { ...mention, at: 3 }] },
    { key: 'WEB-3', changes: [assignment, mention, assignment] },
    { key: 'WEB-4', changes: [assignment] },
    { key: 'WEB-5', changes: [{ field: 'priority', risk: true, at: 4 }] },
  ];
  const before = structuredClone(fresh);
  tracker.announce(fresh);
  assert.deepEqual(notes, [{ title: '5 issues changed · 2 assigned to you · 2 mention you · 1 with risk changes', body: 'WEB-3, WEB-4, WEB-2, WEB-5, WEB-1', key: null }]);
  assert.deepEqual(fresh, before);
});

test('old pending assignments and suppressed own assignments never displace a fresh comment', async t => {
  const { jira, tracker, notes } = await setup(t);
  jira.addIssue({ key: 'WEB-1', summary: 'One', updated: Date.now() - DAY });
  await tracker.addIssues('WEB-1');
  await tracker.check();
  const at = Date.now();
  jira.change('WEB-1', { field: 'assignee', to: 'Demo User', at });
  await tracker.check();
  jira.change('WEB-1', { field: 'assignee', to: 'Demo User', author: jira.people.me, at: at + 1000 });
  jira.comment('WEB-1', 'Fresh comment', jira.people.sam, at + 2000);
  await tracker.check();
  assert.equal(notes.length, 2);
  assert.equal(notes[1].title, 'WEB-1 changed');
  assert.equal(notes[1].body, 'Sam Rivera: “Fresh comment”');
});

test('stored comment flags follow A → unknown → B through every identity lookup', async t => {
  for (const lookup of ['check', 'testConnection', 'loadPeople']) await t.test(lookup, async t => {
    const { jira, tracker, store, notes } = await setup(t);
    const a = { ...jira.people.me };
    const b = { ...jira.people.alex };
    const now = Date.now();
    jira.addIssue({ key: 'WEB-1', summary: 'Account mentions', updated: now - DAY });
    await tracker.addIssues('WEB-1');
    await tracker.check();
    jira.comment('WEB-1', 'For A', jira.people.sam, now, [a]);
    jira.comment('WEB-1', 'For B', jira.people.sam, now + 1000, [b]);
    jira.comment('WEB-1', 'Own change', a, now + 2000, [b]);
    await tracker.check();
    const entry = tracker.find('WEB-1');
    entry.changes.push({ id: 'legacy', field: 'comment', to: '@Demo User', author: { name: 'Sam Rivera' }, processed: false });
    const flags = data => data.tracked[0].changes.map(c => !!c.mentionsMe);
    const processing = entry.changes.map(c => [c.own, c.processed, c.processedAt]);
    let persisted;
    store.save = function () { this.saves++; persisted = JSON.parse(JSON.stringify(this.data)); };
    const assertFlags = expected => {
      assert.deepEqual(flags(store.data), expected);
      assert.deepEqual(flags(tracker.publicState()), expected);
      assert.deepEqual(flags(persisted), expected);
      assert.deepEqual(entry.changes.map(c => [c.own, c.processed, c.processedAt]), processing);
    };
    store.save();
    assertFlags([true, false, false, false]);
    notes.length = 0;
    if (lookup === 'check') tracker.credentialsChanged(); // token changes reset identity directly
    else tracker.saveSettings({ email: 'b@example.com' });
    assert.equal(tracker.data.me, null);
    assertFlags([false, false, false, false]);
    jira.myselfStatus = 401;
    assert.equal((await tracker.check()).ok, false);
    assertFlags([false, false, false, false]);
    jira.myselfStatus = null;
    Object.assign(jira.people.me, b);
    await tracker[lookup]();
    assert.equal(tracker.data.me.accountId, b.accountId);
    assertFlags([false, true, true, false]);
    assert.equal(notes.length, 0); // switching accounts never re-announces existing changes
    for (const [index, expected] of [[0, false], [1, true], [3, false]]) {
      tracker.announce([{ key: entry.key, summary: entry.issue.summary, changes: [entry.changes[index]] }]);
      assert.equal(notes.pop().body.includes('mentioned you'), expected);
    }
  });
});

test('loading stored mention flags derives them from the saved identity and handles legacy records', () => {
  for (const accountId of ['a', 'b', null]) {
    const data = ensureShape({
      me: accountId ? { accountId } : null,
      tracked: [{ key: 'WEB-1', changes: [
        { field: 'comment', mentions: [{ accountId: 'a' }], mentionsMe: true },
        { field: 'comment', mentions: [{ accountId: 'b' }] },
        { field: 'comment', to: '@A', mentionsMe: true }, // legacy: no account ids
      ] }],
    });
    assert.deepEqual(data.tracked[0].changes.map(c => !!c.mentionsMe), [accountId === 'a', accountId === 'b', false]);
  }
});

test('undo of untrack reclassifies comments for the current account without changing processing', async t => {
  for (const identity of [null, { accountId: 'b' }]) await t.test(identity ? 'B' : 'unknown', async t => {
    const { tracker, store, notes } = await trackedSetup(t, 'WEB-1');
    const entry = tracker.find('WEB-1');
    entry.changes = [
      { field: 'comment', mentions: [{ accountId: 'a' }], own: true, processed: true, processedAt: 123 },
      { field: 'comment', mentions: [{ accountId: 'b' }], processed: false, processedAt: null },
      { field: 'comment', to: '@A', mentionsMe: true, processed: false },
    ];
    tracker.setMe({ accountId: 'a' });
    const processing = entry.changes.map(c => [c.own, c.processed, c.processedAt]);
    tracker.untrack('WEB-1');
    tracker.credentialsChanged();
    tracker.setMe(identity);
    let persisted;
    store.save = () => { persisted = JSON.parse(JSON.stringify(store.data)); };
    assert.equal(tracker.restore('WEB-1'), true);
    assert.deepEqual(persisted.tracked[0].changes.map(c => !!c.mentionsMe), [false, !!identity, false]);
    assert.deepEqual(entry.changes.map(c => [c.own, c.processed, c.processedAt]), processing);
    assert.equal(notes.length, 0);
  });
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('superseded identity lookups leave A → unknown → B and the newest people request intact', async t => {
  for (const path of ['testConnection', 'loadPeople', 'check']) {
    for (const fails of [false, true]) await t.test(`${path}: stale ${fails ? 'failure' : 'success'}`, async t => {
      const { tracker, store, notes, timers } = await trackedSetup(t, 'WEB-1');
      const entry = tracker.find('WEB-1');
      const a = { accountId: 'a', name: 'A' }, b = { accountId: 'b', name: 'B' };
      entry.changes = [
        { id: 'ca', field: 'comment', mentions: [{ accountId: 'a' }], processed: false },
        { id: 'cb', field: 'comment', mentions: [{ accountId: 'b' }], own: true, processed: true, processedAt: 123 },
      ];
      tracker.setMe(a);
      const processing = entry.changes.map(c => [c.own, c.processed, c.processedAt]);
      if (path === 'loadPeople') tracker.credentialsChanged(); // force its /myself lookup
      const old = deferred(), started = deferred(), newestUsers = deferred();
      let oldUsers = 0, oldSearches = 0;
      tracker.getClient = () => ({
        myself: () => { started.resolve(); return old.promise; },
        bulkFetch: async () => ({ issues: [], errors: [] }),
        users: async () => { oldUsers++; return []; },
        search: async () => { oldSearches++; return { issues: [] }; },
      });
      const stale = tracker[path]();
      await started.promise;
      tracker.credentialsChanged();
      assert.equal(tracker.data.me, null);
      assert.deepEqual(entry.changes.map(c => !!c.mentionsMe), [false, false]);
      tracker.getClient = () => ({ myself: async () => b, users: () => newestUsers.promise });
      await tracker.testConnection(); // installs B and starts a new pending people request
      const newest = tracker.people;
      assert.equal(newest.loading, true);
      assert.equal(tracker.data.me.accountId, 'b');
      const before = { saves: store.saves, timers: timers.length, status: tracker.status, lastCheck: tracker.data.lastCheck };
      if (fails) old.reject(Object.assign(new Error('Old credentials failed'), { code: 'auth' }));
      else old.resolve(a);
      await stale;
      assert.equal(tracker.data.me.accountId, 'b');
      assert.deepEqual(entry.changes.map(c => !!c.mentionsMe), [false, true]);
      assert.deepEqual(entry.changes.map(c => [c.own, c.processed, c.processedAt]), processing);
      assert.equal(tracker.people, newest); // an old request cannot clear the new loading state
      assert.equal(tracker.people.loading, true);
      assert.equal(store.saves, before.saves);
      assert.equal(timers.length, before.timers);
      assert.equal(tracker.status, before.status);
      assert.equal(tracker.data.lastCheck, before.lastCheck);
      assert.equal(tracker.data.reconnected, true);
      assert.equal(entry.missingSince, undefined);
      assert.equal(entry.error ?? null, null);
      assert.equal(notes.length, 0);
      assert.equal(oldUsers, 0);
      assert.equal(oldSearches, 0);
      newestUsers.resolve([b]);
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(tracker.people.list, [b]);
      assert.equal(tracker.people.loading, false);
    });
  }
});

test('superseded people-list responses cannot replace the newest account list or clear loading', async t => {
  for (const fails of [false, true]) await t.test(fails ? 'failure' : 'success', async t => {
    const { tracker } = await setup(t);
    const old = deferred(), newest = deferred();
    tracker.setMe({ accountId: 'a' });
    tracker.getClient = () => ({ users: () => old.promise });
    const stale = tracker.loadPeople();
    tracker.credentialsChanged();
    tracker.setMe({ accountId: 'b' });
    tracker.getClient = () => ({ users: () => newest.promise });
    const current = tracker.loadPeople();
    const pending = tracker.people;
    if (fails) old.reject(new Error('Old people failed'));
    else old.resolve([{ accountId: 'a' }]);
    await stale;
    assert.equal(tracker.people, pending);
    assert.equal(tracker.people.loading, true);
    newest.resolve([{ accountId: 'b' }]);
    await current;
    assert.deepEqual(tracker.people.list, [{ accountId: 'b' }]);
    assert.equal(tracker.people.error, null);
  });
});

test('a reconnect timer consumed by an older check is scheduled again after it finishes', async t => {
  const { tracker } = await setup(t);
  let now = 1000;
  tracker.now = () => now;
  const pending = deferred(), started = deferred();
  tracker.getClient = () => ({ myself: () => { started.resolve(); return pending.promise; } });
  const timers = [];
  tracker.setTimer = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const old = tracker.check();
  await started.promise;
  tracker.credentialsChanged();
  assert.equal(timers.at(-1).ms, 1000);
  now += 1000;
  timers.at(-1).fn(); // rejoins the old request; cannot check the new account yet
  pending.resolve({ accountId: 'old', name: 'Old' });
  await old;
  assert.equal(tracker.data.me, null);
  assert.equal(timers.length, 2);
  assert.equal(timers.at(-1).ms, 1000);
  assert.equal(tracker.nextCheck, now + 1000);
});

/* ---------- a request for one issue's changes fails during a check ---------- */

/** Two changes on `key` that a snapshot cannot show: a comment and an attachment, each with its author. */
function commentAndAttachment(jira, key = 'WEB-1') {
  jira.comment(key, 'Please review before Friday', jira.people.sam);
  jira.change(key, { field: 'Attachment', from: null, to: 'spec.pdf', author: jira.people.sam });
}

for (const [name, endpoint, fault] of [
  ['a 503 on the comments', 'comment', { status: 503 }],
  ['a 502 HTML page on the changelog', 'changelog', { status: 502, body: '<html><body>502 Bad Gateway</body></html>' }],
  ['a 200 {} on the comments', 'comment', { status: 200, body: '{}' }],
  ['a 200 {} on the changelog', 'changelog', { status: 200, body: '{}' }],
  ['a 200 with a body that is no JSON', 'comment', { status: 200, body: 'Sign in to the Wi-Fi' }],
]) {
  test(`${name} records nothing and keeps seenUntil; the next check records it all, notified once`, async t => {
    const { jira, tracker, notes } = await trackedSetup(t, 'WEB-1');
    const entry = tracker.find('WEB-1');
    const seenUntil = entry.seenUntil;
    commentAndAttachment(jira);
    jira.fail(endpoint, fault);

    const failed = await tracker.check();
    assert.equal(failed.ok, false);
    assert.deepEqual(entry.changes, []);
    assert.equal(entry.seenUntil, seenUntil);
    assert.equal(tracker.status.state, 'error');
    assert.equal(notes.length, 0);

    assert.deepEqual(await tracker.check(), { ok: true, found: 2 });
    assert.deepEqual(entry.changes.map(c => [c.field, c.author?.name]).sort(), [['attachment', 'Sam Rivera'], ['comment', 'Sam Rivera']]);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].key, 'WEB-1');
    assert.deepEqual(await tracker.check(), { ok: true, found: 0 });
    assert.equal(notes.length, 1);
  });
}

test('a lasting refusal of the changelog (403) falls back to what the issue itself shows', async t => {
  const { jira, tracker, notes } = await trackedSetup(t, 'WEB-1');
  jira.fail('changelog', { count: 99, status: 403, body: { errorMessages: ['You do not have permission to view the changelog.'] } });
  jira.change('WEB-1', { field: 'status', from: 'To Do', to: 'Review', author: jira.people.alex });
  assert.deepEqual(await tracker.check(), { ok: true, found: 1 });
  assert.deepEqual(tracker.find('WEB-1').changes.map(c => [c.field, c.to]), [['status', 'Review']]);
  assert.equal(notes.length, 1);
});

test('a 404 on the changelog of an issue that still exists falls back to what the issue itself shows', async t => {
  const { jira, tracker } = await trackedSetup(t, 'WEB-1');
  jira.fail('changelog', { count: 99, status: 404, body: { errorMessages: ['Not found.'] } });
  jira.change('WEB-1', { field: 'status', from: 'To Do', to: 'Review', author: jira.people.alex });
  assert.deepEqual(await tracker.check(), { ok: true, found: 1 });
  assert.deepEqual(tracker.find('WEB-1').changes.map(c => [c.field, c.to]), [['status', 'Review']]);
});

test('a 404 for an issue that is back by the time it is checked is asked once more, not recorded from the snapshot', async t => {
  const { jira, tracker, notes } = await trackedSetup(t, 'WEB-1');
  commentAndAttachment(jira);
  const real = tracker.getClient;
  let vanished = false;
  let back = false;
  tracker.getClient = () => ({
    ...real(),
    // The issue is gone for the changelog request, and back for the check that asks whether it still exists.
    changelog: async key => { if (!vanished) { vanished = true; jira.remove(key); } return real().changelog(key); },
    bulkFetch: async keys => { if (vanished && !back) { back = true; jira.restore('WEB-1'); } return real().bulkFetch(keys); },
  });
  assert.deepEqual(await tracker.check(), { ok: true, found: 2 });
  assert.deepEqual(tracker.find('WEB-1').changes.map(c => [c.field, c.author?.name]).sort(), [['attachment', 'Sam Rivera'], ['comment', 'Sam Rivera']]);
  assert.equal(notes.length, 1);
});

test('a 404 because the issue disappeared after the bulk fetch records nothing; the issue is retried', async t => {
  const { jira, tracker, notes } = await trackedSetup(t, 'WEB-1');
  const entry = tracker.find('WEB-1');
  const seenUntil = entry.seenUntil;
  commentAndAttachment(jira);
  const real = tracker.getClient;
  tracker.getClient = () => ({ ...real(), changelog: async key => { jira.remove(key); return real().changelog(key); } });
  assert.equal((await tracker.check()).ok, false);
  assert.deepEqual(entry.changes, []);
  assert.equal(entry.seenUntil, seenUntil);

  tracker.getClient = real;
  jira.restore('WEB-1');
  assert.deepEqual(await tracker.check(), { ok: true, found: 2 });
  assert.equal(entry.changes.length, 2);
  assert.equal(notes.length, 1);
});

/* ---------- changes found by a check that then fails are still announced ---------- */

test('a 429 on one issue: the other issue is recorded and notified, the failing one waits, and nothing runs on after the check', async t => {
  const { jira, tracker, notes, timers } = await trackedSetup(t, 'WEB-1', 'WEB-2');
  jira.comment('WEB-1', 'First', jira.people.sam);
  jira.comment('WEB-2', 'Can you look at this today?', jira.people.alex);
  jira.fail('comment', { key: 'WEB-1', status: 429, body: { errorMessages: ['Rate limit exceeded.'] }, headers: { 'Retry-After': '3600' } });

  const failed = await tracker.check();
  assert.equal(failed.ok, false);
  assert.equal(tracker.status.code, 'rate_limited');
  assert.equal(timers.at(-1), 3_600_000); // the Retry-After is still honoured
  assert.deepEqual(notes.map(n => n.key), ['WEB-2']);
  const snapshot = JSON.stringify(tracker.data.tracked);
  assert.equal(tracker.find('WEB-1').changes.length, 0);
  assert.equal(tracker.find('WEB-2').changes.length, 1);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(JSON.stringify(tracker.data.tracked), snapshot); // nothing changes after check() resolved

  assert.deepEqual(await tracker.check(), { ok: true, found: 1 });
  assert.deepEqual(notes.map(n => n.key), ['WEB-2', 'WEB-1']); // each change notified exactly once
  assert.equal(tracker.find('WEB-2').changes.length, 1);
});

test('an authentication error on one issue still announces what the others recorded', async t => {
  const { jira, tracker, notes } = await trackedSetup(t, 'WEB-1', 'WEB-2');
  jira.comment('WEB-1', 'First', jira.people.sam);
  jira.comment('WEB-2', 'Second', jira.people.alex);
  jira.fail('comment', { key: 'WEB-1', status: 401, body: { errorMessages: ['Unauthorized'] } });
  const failed = await tracker.check();
  assert.equal(failed.ok, false);
  assert.equal(tracker.status.code, 'auth');
  assert.deepEqual(notes.map(n => n.key), ['WEB-2']);
});

test('a failing /myself before reporting a missing issue still announces the recorded changes', async t => {
  const { jira, tracker, notes } = await trackedSetup(t, 'WEB-1', 'WEB-2');
  jira.remove('WEB-1');
  jira.comment('WEB-2', 'Can you look at this today?', jira.people.alex);
  jira.fail('myself', { count: 1, status: 503 });
  const failed = await tracker.check();
  assert.equal(failed.ok, false);
  assert.deepEqual(notes.map(n => n.key), ['WEB-2']);
  assert.equal(tracker.find('WEB-1').missingSince, undefined);
  assert.ok(tracker.find('WEB-1').error); // red, but not yet recorded as gone

  assert.deepEqual(await tracker.check(), { ok: true, found: 1 });
  assert.deepEqual(notes.map(n => n.key), ['WEB-2', 'WEB-1']);
  assert.equal(tracker.find('WEB-2').changes.length, 1);
});

/* ---------- which failures wait, and what a waiting issue does not hold up ---------- */

/** The changelog request of `only` (or of every issue) removes the issue first, as if it was deleted after the bulk fetch: a 404. */
function vanishOnChangelog(tracker, jira, only = null) {
  const real = tracker.getClient;
  tracker.getClient = () => ({ ...real(), changelog: async key => { if (!only || key === only) jira.remove(key); return real().changelog(key); } });
  return () => { tracker.getClient = real; };
}

test('a 404 on one issue and a 503 on another: the transient error is reported, with its backoff', async t => {
  const { jira, tracker, timers } = await trackedSetup(t, 'WEB-1', 'WEB-2');
  jira.comment('WEB-1', 'One', jira.people.sam);
  jira.comment('WEB-2', 'Two', jira.people.sam);
  jira.fail('comment', { key: 'WEB-2', status: 503 });
  vanishOnChangelog(tracker, jira, 'WEB-1');
  const r = await tracker.check();
  assert.equal(r.ok, false);
  assert.match(r.error, /server error/); // the 503, not the 404
  assert.equal(timers.at(-1), 30_000);
  assert.equal(tracker.failures, 1);
});

test('several rate limits: the next check waits for the longest Retry-After', async t => {
  const { jira, tracker, timers } = await trackedSetup(t, 'WEB-1', 'WEB-2');
  jira.comment('WEB-1', 'One', jira.people.sam);
  jira.comment('WEB-2', 'Two', jira.people.sam);
  jira.fail('comment', { key: 'WEB-1', status: 429, headers: { 'Retry-After': '3600' } });
  jira.fail('comment', { key: 'WEB-2', status: 429, headers: { 'Retry-After': '7200' } });
  assert.equal((await tracker.check()).ok, false);
  assert.equal(timers.at(-1), 7_200_000);
});

test('a malformed changelog skips the bad entries; it never leaves the issue waiting', async t => {
  const { jira, tracker, notes } = await trackedSetup(t, 'WEB-1');
  jira.comment('WEB-1', 'Please review', jira.people.sam);
  const values = [null, 5, 'x', { created: 7 }, { id: '1', created: '2999-01-01T00:00:00.000+0000', items: [null, 3, { field: 'status', toString: 'Review' }] }];
  jira.fail('changelog', { status: 200, body: JSON.stringify({ values, total: 5 }) });
  assert.deepEqual(await tracker.check(), { ok: true, found: 2 });
  assert.deepEqual(tracker.find('WEB-1').changes.map(c => c.field).sort(), ['comment', 'status']);
  assert.equal(notes.length, 1);
});

test('a parse that throws is no reason to wait for ever: the snapshot takes over', async t => {
  const { jira, tracker } = await trackedSetup(t, 'WEB-1');
  jira.change('WEB-1', { field: 'status', from: 'To Do', to: 'Review', author: jira.people.alex });
  const real = tracker.getClient;
  tracker.getClient = () => ({ ...real(), changelog: async () => [{ get created() { throw new TypeError('boom'); } }] });
  assert.deepEqual(await tracker.check(), { ok: true, found: 1 });
  assert.deepEqual(tracker.find('WEB-1').changes.map(c => [c.field, c.to]), [['status', 'Review']]);
  assert.equal(tracker.find('WEB-1').seenUntil, jira.issues.get('WEB-1').fields.updated);
});

test('issues that keep failing do not hold up the rest: Stale refreshes, the deleted issue is announced, a 400 falls back to the snapshot', async t => {
  const { jira, tracker, notes } = await trackedSetup(t, 'WEB-1', 'WEB-2', 'WEB-3', 'WEB-4');
  jira.comment('WEB-1', 'Always 500', jira.people.sam);
  jira.fail('comment', { key: 'WEB-1', count: 99, status: 500 });
  jira.remove('WEB-2');
  jira.change('WEB-3', { field: 'status', from: 'To Do', to: 'Review', author: jira.people.alex });
  jira.fail('changelog', { key: 'WEB-3', count: 99, status: 400, body: { errorMessages: ['Bad request'] } });
  jira.comment('WEB-4', 'Fine', jira.people.alex);
  const searches = () => jira.requests.filter(q => q.path.endsWith('/search/jql')).length;
  const before = searches();
  tracker.data.lastCheck = 1;
  const r = await tracker.check();
  assert.equal(r.ok, false);
  assert.match(r.error, /server error/);
  assert.equal(r.found, 3);
  assert.equal(searches(), before + 1); // the Stale refresh ran
  assert.ok(tracker.data.stale.fetchedAt);
  assert.ok(tracker.data.lastCheck > 1); // and the check counts as an answer
  assert.deepEqual(tracker.find('WEB-1').changes, []); // waits
  assert.deepEqual(tracker.find('WEB-2').changes.map(c => c.field), ['gone']);
  assert.deepEqual(tracker.find('WEB-3').changes.map(c => [c.field, c.to]), [['status', 'Review']]);
  assert.equal(tracker.find('WEB-4').changes.length, 1);
  assert.deepEqual(notes.map(n => n.key).sort(), ['WEB-2', 'WEB-3', 'WEB-4']);
});

test('a waiting issue keeps its lastChecked from its last answer', async t => {
  const { jira, tracker } = await trackedSetup(t, 'WEB-1');
  const entry = tracker.find('WEB-1');
  entry.lastChecked = 1234;
  jira.comment('WEB-1', 'One', jira.people.sam);
  jira.fail('comment', { status: 503 });
  await tracker.check();
  assert.equal(entry.lastChecked, 1234);
  await tracker.check();
  assert.ok(entry.lastChecked > 1234);
});

test('after a 429 no new changelog or comments request starts; the issues not reached wait for the next check', async t => {
  const keys = Array.from({ length: 20 }, (_, n) => `WEB-${n + 1}`);
  const { jira, tracker, notes } = await trackedSetup(t, ...keys);
  for (const key of keys) jira.comment(key, `Comment on ${key}`, jira.people.sam);
  jira.fail('comment', { status: 429, headers: { 'Retry-After': '3600' } });
  const asked = () => new Set(jira.requests.filter(q => /\/(changelog|comment)$/.test(q.path)).map(q => q.path.split('/')[5]));
  const before = asked().size;
  const failed = await tracker.check();
  assert.equal(failed.ok, false);
  assert.equal(tracker.status.code, 'rate_limited');
  assert.ok(asked().size - before <= 4, `${asked().size - before} issues asked`); // only the first issue of each of the four workers
  const recorded = tracker.data.tracked.filter(x => x.changes.length).length;
  assert.ok(recorded < 20);
  assert.equal(tracker.data.tracked.filter(x => x.seenUntil < jira.issues.get(x.key).fields.updated).length, 20 - recorded);

  assert.equal((await tracker.check()).ok, true);
  assert.deepEqual(tracker.data.tracked.map(x => x.changes.length), keys.map(() => 1)); // each once
  const named = notes.flatMap(n => (n.key ? [n.key] : n.body.split(', ')));
  assert.equal(named.length, 20);
  assert.equal(new Set(named).size, 20); // each notified once
});

test('a vanished 404 waits, and the next check reports the issue as missing', async t => {
  const { jira, tracker, notes } = await trackedSetup(t, 'WEB-1');
  jira.comment('WEB-1', 'One', jira.people.sam);
  vanishOnChangelog(tracker, jira);
  const r = await tracker.check();
  assert.equal(r.ok, false);
  assert.deepEqual(tracker.find('WEB-1').changes, []);
  assert.equal(notes.length, 0);
  assert.deepEqual(await tracker.check(), { ok: true, found: 1 });
  assert.deepEqual(tracker.find('WEB-1').changes.map(c => c.field), ['gone']);
  assert.deepEqual(notes.map(n => n.key), ['WEB-1']);
});

test('a refused login: no missing issue is concluded from it', async t => {
  const { jira, tracker, notes } = await trackedSetup(t, 'WEB-1', 'WEB-2');
  jira.remove('WEB-1');
  jira.comment('WEB-2', 'Two', jira.people.sam);
  jira.fail('comment', { status: 401, body: { errorMessages: ['Unauthorized'] } });
  const failed = await tracker.check();
  assert.equal(tracker.status.code, 'auth');
  assert.equal(failed.ok, false);
  assert.deepEqual(tracker.find('WEB-1').changes, []);
  assert.equal(tracker.find('WEB-1').missingSince, undefined);
  assert.ok(tracker.find('WEB-1').error);
  assert.equal(notes.length, 0);
});

test('a bug while recording one issue ends that issue only: the others finish and nothing runs on after the check', async t => {
  const { jira, tracker, notes } = await trackedSetup(t, 'WEB-1', 'WEB-2', 'WEB-3');
  for (const key of ['WEB-1', 'WEB-2', 'WEB-3']) jira.comment(key, `On ${key}`, jira.people.sam);
  const prune = tracker.prune.bind(tracker);
  tracker.prune = entry => { if (entry.key === 'WEB-1') throw new TypeError('boom'); prune(entry); };
  const r = await tracker.check();
  assert.equal(r.ok, false);
  assert.equal(r.error, 'boom');
  assert.deepEqual(notes.map(n => n.key).sort(), ['WEB-2', 'WEB-3']);
  const snapshot = JSON.stringify(tracker.data.tracked);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(JSON.stringify(tracker.data.tracked), snapshot);
});

/* ---------- one tracked list per Jira site (host) ---------- */

/** Tracker on mock site A (`jira`), with a second mock site `other`; both number their issues from 10001, so ids collide. */
async function setupTwoSites(t) {
  const ctx = await setup(t);
  const other = createMockJira({ email: 'user@example.com', token: 'tok' });
  await other.start();
  t.after(() => other.stop());
  ctx.jira.addIssue({ key: 'WEB-1', summary: 'Site A: checkout broken', assignee: ctx.jira.people.me, updated: Date.now() - 30 * DAY });
  other.addIssue({ key: 'HR-7', summary: 'Site B: salary review', updated: Date.now() - DAY });
  const switchTo = site => ctx.tracker.saveSettings({ baseUrl: site.url, token: 'tok' }); // another host clears the token unless the patch brings one
  return { ...ctx, other, switchTo };
}

test('switching to another Jira site: its issue with the same id is never taken for a tracked issue', async t => {
  const { jira, other, tracker, notes, switchTo } = await setupTwoSites(t);
  assert.equal(jira.issues.get('WEB-1').id, other.issues.get('HR-7').id);
  await tracker.addIssues('WEB-1');
  switchTo(other);
  assert.deepEqual(tracker.data.tracked, []);
  await tracker.check();
  other.comment('HR-7', 'Confidential: approved', other.people.alex);
  await tracker.check();
  assert.deepEqual(tracker.data.tracked, []);
  assert.deepEqual(notes, []);
});

test('each Jira site has its own list: switching back restores the old one with its changes and seen state', async t => {
  const { jira, other, tracker, notes, switchTo } = await setupTwoSites(t);
  await tracker.addIssues('WEB-1');
  jira.change('WEB-1', { field: 'priority', from: 'Medium', to: 'High', author: jira.people.alex });
  await tracker.check();
  assert.equal(notes.length, 1);
  const before = JSON.parse(JSON.stringify(tracker.data.tracked));
  assert.equal(before[0].changes.length, 1);

  switchTo(other);
  await tracker.addIssues('HR-7');
  assert.deepEqual(tracker.data.tracked.map(x => [x.key, x.issue.summary]), [['HR-7', 'Site B: salary review']]);
  other.comment('HR-7', 'Looks fine', other.people.alex);
  await tracker.check();
  assert.equal(tracker.find('HR-7').changes.length, 1);
  assert.equal(notes.length, 2);

  switchTo(jira);
  assert.deepEqual(tracker.data.tracked, before);
  await tracker.check();
  assert.deepEqual(tracker.data.tracked.map(x => [x.key, x.issue.summary]), [['WEB-1', 'Site A: checkout broken']]);
  assert.equal(tracker.find('WEB-1').changes.length, 1);
  assert.equal(notes.length, 2); // nothing of site B was notified again, nor anything new for A

  switchTo(other);
  assert.deepEqual(tracker.data.tracked.map(x => x.key), ['HR-7']);
  assert.equal(tracker.find('HR-7').changes.length, 1);
});

test('only the host counts: email, path, scheme, case and a trailing slash keep the list', async t => {
  const { jira, tracker } = await setupTwoSites(t);
  await tracker.addIssues('WEB-1');
  const entry = tracker.find('WEB-1');
  tracker.saveSettings({ email: 'someone.else@example.com' });
  assert.equal(tracker.find('WEB-1'), entry);
  const host = new URL(jira.url).host;
  for (const url of [`http://${host}/`, `HTTP://${host.toUpperCase()}/jira/software`, ` ${host}/browse/WEB-1 `]) {
    tracker.saveSettings({ baseUrl: url });
    assert.equal(tracker.find('WEB-1'), entry, url);
  }
  assert.deepEqual(tracker.data.sites, []);
});

test('an emptied URL keeps the list of the old site for later', async t => {
  const { jira, tracker } = await setupTwoSites(t);
  await tracker.addIssues('WEB-1');
  tracker.saveSettings({ baseUrl: '' });
  assert.deepEqual(tracker.data.tracked, []);
  tracker.saveSettings({ baseUrl: jira.url, token: 'tok' });
  assert.deepEqual(tracker.data.tracked.map(x => x.key), ['WEB-1']);
});

test('storage from before there was a list per site belongs to the configured host', async t => {
  const { jira, other, tracker, store, switchTo } = await setupTwoSites(t);
  await tracker.addIssues('WEB-1');
  const old = JSON.parse(JSON.stringify(store.data));
  delete old.site;
  delete old.sites;
  old.version = 4;
  const migrated = ensureShape(old);
  assert.equal(migrated.site, new URL(jira.url).host);
  assert.deepEqual(migrated.sites, []);
  assert.deepEqual(migrated.tracked.map(x => x.key), ['WEB-1']);
  // And it behaves like a list that was always kept per site.
  store.data = migrated;
  switchTo(other);
  assert.deepEqual(tracker.data.tracked, []);
  switchTo(jira);
  assert.deepEqual(tracker.data.tracked.map(x => x.key), ['WEB-1']);
});

test('the lists of other sites survive a restart, and malformed ones are dropped', async t => {
  const { jira, other, tracker, store, switchTo } = await setupTwoSites(t);
  await tracker.addIssues('WEB-1');
  switchTo(other);
  const reloaded = ensureShape(JSON.parse(JSON.stringify(store.data)));
  assert.deepEqual(reloaded.sites.map(s => [s.host, s.tracked.map(x => x.key)]), [[new URL(jira.url).host, ['WEB-1']]]);
  const broken = ensureShape({ settings: { baseUrl: jira.url }, sites: [null, { host: 5 }, { host: 'x.example', tracked: 'no' }, { host: 'y.example', tracked: [{ key: 'A-1' }, null] }] });
  assert.deepEqual(broken.sites.map(s => [s.host, s.tracked.map(x => x.key)]), [['y.example', ['A-1']]]);
  assert.deepEqual(broken.sites[0].tracked[0].changes, []);
});

test('a check that is on its way when the site changes writes nothing into either list', async t => {
  const { jira, other, tracker, notes, switchTo } = await setupTwoSites(t);
  await tracker.addIssues('WEB-1');
  jira.comment('WEB-1', 'Site A news', jira.people.alex, Date.now());
  const running = tracker.check(); // asks site A
  switchTo(other);
  await running;
  assert.deepEqual(tracker.data.tracked, []);
  assert.deepEqual(notes, []);
  switchTo(jira);
  assert.deepEqual(tracker.find('WEB-1').changes, []); // the answer of the interrupted check was dropped, not half applied
  await tracker.check();
  assert.equal(tracker.find('WEB-1').changes.length, 1);
});

test('adding an issue that is on its way when the site changes does not land in the new list', async t => {
  const { jira, other, tracker, switchTo } = await setupTwoSites(t);
  other.addIssue({ key: 'WEB-1', summary: 'Site B: same key and id' });
  const adding = tracker.addIssues('WEB-1'); // asks site A
  switchTo(other);
  const r = await adding;
  assert.equal(r.ok, false);
  assert.deepEqual(tracker.data.tracked, []);
  switchTo(jira);
  assert.deepEqual(tracker.data.tracked, []); // no half-added placeholder was kept for A either
});

test('Undo of Stop tracking cannot bring an issue of another site back', async t => {
  const { jira, other, tracker, switchTo } = await setupTwoSites(t);
  await tracker.addIssues('WEB-1');
  assert.equal(tracker.untrack('WEB-1'), true);
  switchTo(other);
  assert.equal(tracker.restore('WEB-1'), false);
  assert.deepEqual(tracker.data.tracked, []);
  switchTo(jira);
  assert.equal(tracker.restore('WEB-1'), false);
});

test('the Stale list of the previous site goes with the switch, and Track cannot use it', async t => {
  const { jira, other, tracker, switchTo } = await setupTwoSites(t);
  await tracker.check();
  assert.deepEqual(tracker.data.stale.issues.map(i => i.key), ['WEB-1']);
  const staleA = JSON.parse(JSON.stringify(tracker.data.stale));
  switchTo(other);
  assert.deepEqual(tracker.data.stale, { issues: [], fetchedAt: null, error: null, site: new URL(other.url).host });
  const r = await tracker.track('WEB-1'); // not in the (empty) list: asked of the new site, which does not know it
  assert.deepEqual(r.added, []);
  assert.deepEqual(tracker.data.tracked, []);
  // A list that does belong to another site is refused, however it got there.
  tracker.data.stale = staleA;
  const refused = await tracker.track('WEB-1');
  assert.deepEqual(refused, { ok: false, error: 'The Jira site changed while this was running.' });
  assert.deepEqual(tracker.data.tracked, []);
  switchTo(jira);
  assert.deepEqual(tracker.data.stale.issues, []);
});

test('a failed Stale refresh on the new site never keeps issues of the previous one', async t => {
  const { jira, other, tracker, switchTo } = await setupTwoSites(t);
  await tracker.check();
  switchTo(other);
  tracker.data.stale = { ...tracker.data.stale, issues: [{ key: 'WEB-1', id: '10001' }], site: new URL(jira.url).host }; // as a list fetched before the switch
  tracker.getClient = () => ({ search: async () => { throw Object.assign(new Error('Bad query'), { status: 400 }); } });
  await tracker.refreshStale(tracker.getClient());
  assert.deepEqual(tracker.data.stale.issues, []);
  assert.equal(tracker.data.stale.error, 'Bad query');
  assert.equal(tracker.data.stale.site, new URL(other.url).host);
});

test('Undo of Processed cannot reach a change of another site, also after switching back', async t => {
  const { jira, other, tracker, switchTo } = await setupTwoSites(t);
  await tracker.addIssues('WEB-1');
  jira.comment('WEB-1', 'News', jira.people.alex, Date.now());
  await tracker.check();
  const ids = tracker.markProcessed(['WEB-1']);
  assert.equal(ids.length, 1);
  switchTo(other);
  switchTo(jira);
  assert.equal(tracker.find('WEB-1').changes[0].processed, true);
  tracker.unmark(ids);
  assert.equal(tracker.find('WEB-1').changes[0].processed, true);
  const again = tracker.markProcessed(['WEB-1']); // nothing pending: nothing to undo either
  assert.deepEqual(again, []);
});

test('the site of the stored list is the configured host, whatever the file says', async t => {
  const { jira, tracker, store } = await setupTwoSites(t);
  await tracker.addIssues('WEB-1');
  const host = new URL(jira.url).host;
  const edited = { ...JSON.parse(JSON.stringify(store.data)), site: 'unrelated.example' };
  assert.equal(ensureShape(JSON.parse(JSON.stringify(edited))).site, host);
  store.data = ensureShape(edited);
  const gen = tracker.credentialsGen;
  const entry = tracker.find('WEB-1');
  tracker.saveSettings({ theme: 'dark' }); // an unrelated save must not swap the list
  assert.equal(tracker.find('WEB-1'), entry);
  assert.equal(tracker.credentialsGen, gen);
  assert.deepEqual(tracker.data.sites, []);
});

test('storage from before: the Stale list is from the configured host, and a list of another site is dropped', () => {
  const old = { version: 4, settings: { baseUrl: 'https://one.example' }, stale: { issues: [{ key: 'A-1' }], fetchedAt: 5, error: null } };
  const d = ensureShape(old);
  assert.equal(d.stale.site, 'one.example');
  assert.deepEqual(d.stale.issues.map(i => i.key), ['A-1']);
  const foreign = ensureShape({ version: 5, settings: { baseUrl: 'https://one.example' }, site: 'one.example', stale: { issues: [{ key: 'B-1' }], fetchedAt: 5, error: 'x', warning: 'w', truncated: true, site: 'two.example' } });
  assert.deepEqual(foreign.stale, { issues: [], fetchedAt: null, error: null, site: 'one.example' });
});

test('the saved lists of other sites carry no mention flags of the current account', () => {
  const comment = { id: 'c1', field: 'comment', at: 1, mentions: [{ accountId: 'me' }], mentionsMe: true, processed: false };
  const entry = () => ({ key: 'A-1', changes: [{ ...comment }] });
  const d = ensureShape({ version: 5, settings: { baseUrl: 'https://one.example' }, me: { accountId: 'me' }, tracked: [entry()], sites: [{ host: 'two.example', tracked: [entry()] }] });
  assert.equal(d.tracked[0].changes[0].mentionsMe, true);
  assert.equal('mentionsMe' in d.sites[0].tracked[0].changes[0], false);
});

test('the first site entered adopts the list held while no URL was set; a later site starts empty', async t => {
  const { jira, other, tracker, store } = await setupTwoSites(t);
  await tracker.addIssues('WEB-1');
  store.data = ensureShape({ ...JSON.parse(JSON.stringify(store.data)), settings: { ...store.data.settings, baseUrl: '' } }); // refused URL in old storage: tracked issues, no URL
  assert.equal(store.data.site, '');
  assert.equal(tracker.data.tracked.length, 1);
  tracker.saveSettings({ baseUrl: jira.url, token: 'tok' });
  assert.deepEqual(tracker.data.tracked.map(x => x.key), ['WEB-1']);
  assert.deepEqual(tracker.data.sites, []);
  tracker.saveSettings({ baseUrl: other.url, token: 'tok' });
  assert.deepEqual(tracker.data.tracked, []);
  assert.deepEqual(tracker.data.sites.map(s => s.host), [new URL(jira.url).host]);
});

test('issue types asked of the previous site are dropped, not remembered for the new one', async t => {
  const { jira, other, tracker, switchTo } = await setupTwoSites(t);
  other.addIssue({ key: 'WEB-9', summary: 'Site B' });
  const asking = tracker.issueTypes('WEB');
  switchTo(other);
  assert.deepEqual(await asking, { ok: false, error: 'The Jira site changed while this was running.' });
  assert.equal(tracker.typeCache.size, 0);
  assert.equal((await tracker.issueTypes('WEB')).ok, true);
  assert.equal(tracker.typeCache.size, 1);
});

test('an Activity answer from the previous site is neither cached nor shown for the new one', async t => {
  const { jira, other, tracker, switchTo } = await setupTwoSites(t);
  jira.comment('WEB-1', 'Site A comment', jira.people.alex);
  other.addIssue({ key: 'WEB-1', summary: 'Site B' });
  const asking = tracker.activity('WEB-1');
  switchTo(other);
  assert.equal((await asking).ok, false);
  assert.equal(tracker.activityCache.size, 0);
});

test('a note that becomes an issue on the previous site is not tracked on the new one', async t => {
  const { jira, other, tracker, switchTo } = await setupTwoSites(t);
  jira.addIssue({ key: 'WEB-2', summary: 'Other' });
  other.addIssue({ key: 'WEB-3', summary: 'Site B: same key as the issue created on site A' });
  tracker.saveSettings({ notesProject: 'WEB' });
  const note = tracker.addNote('Fix it');
  const creating = tracker.createIssueFromNote(note.id);
  switchTo(other);
  const r = await creating;
  assert.equal(r.key, 'WEB-3');
  assert.equal(r.tracked, false);
  assert.equal(r.error, 'The Jira site changed while this was running.');
  assert.deepEqual(tracker.data.tracked, []);
});

/* ---------- a switch of site during the failure paths of a check ---------- */

/** Wraps every client call: `during.<method>` runs while that request is on its way (a switch of site, for these tests). */
function interceptClient(tracker, during) {
  const real = tracker.getClient;
  tracker.getClient = () => {
    const client = real();
    return Object.fromEntries(Object.entries(client).map(([name, fn]) => [name, async (...args) => {
      if (during[name]) await during[name](...args);
      return fn(...args);
    }]));
  };
}

test('a switch of site while the 404 re-check is on its way: nothing is recorded, from a snapshot or otherwise', async t => {
  const { jira, other, tracker, notes, switchTo } = await setupTwoSites(t);
  await tracker.addIssues('WEB-1');
  const seenUntil = tracker.find('WEB-1').seenUntil;
  jira.comment('WEB-1', 'Site A news', jira.people.alex, Date.now());
  let vanished = false;
  let switched = false;
  interceptClient(tracker, {
    changelog: key => { if (!vanished) { vanished = true; jira.remove(key); } }, // a 404 on site A, so the re-check asks
    bulkFetch: () => { if (vanished && !switched) { switched = true; jira.restore('WEB-1'); switchTo(other); } },
  });
  const r = await tracker.check();
  assert.equal(switched, true);
  assert.deepEqual(r, { ok: true, found: 0 }); // an answer of the site we left is dropped
  assert.deepEqual(tracker.data.tracked, []);
  assert.deepEqual(notes, []);
  switchTo(jira);
  assert.deepEqual(tracker.find('WEB-1').changes, []); // the list of site A is as it was
  assert.equal(tracker.find('WEB-1').seenUntil, seenUntil);
});

test('a switch of site while /myself is asked about a missing issue: it is neither recorded nor announced', async t => {
  const { jira, other, tracker, notes, switchTo } = await setupTwoSites(t);
  await tracker.addIssues('WEB-1');
  assert.equal((await tracker.check()).ok, true); // the account is known now, so /myself is only asked about the missing issue
  jira.remove('WEB-1');
  let asked = 0;
  interceptClient(tracker, { myself: () => { asked++; switchTo(other); } });
  const r = await tracker.check();
  assert.equal(asked, 1);
  assert.deepEqual(r, { ok: true, found: 0 });
  assert.deepEqual(tracker.data.tracked, []);
  assert.deepEqual(notes, []);
  switchTo(jira);
  const entry = tracker.find('WEB-1');
  assert.equal(entry.missingSince, undefined);
  assert.deepEqual(entry.changes, []);
});
