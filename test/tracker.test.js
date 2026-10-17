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

test('an assignment to the connected user gets its own notification title', async t => {
  const { jira, tracker, notes } = await setup(t);
  jira.addIssue({ key: 'WEB-1', summary: 'Checkout broken', updated: Date.now() - DAY });
  await tracker.addIssues('WEB-1');
  tracker.data.me = { accountId: jira.people.me.accountId, name: jira.people.me.displayName };
  jira.change('WEB-1', { field: 'assignee', from: 'Jordan Lee', to: 'Demo User', author: jira.people.alex });
  assert.deepEqual(await tracker.check(), { ok: true, found: 1 });
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

test('a vanished issue: a failure on another issue in the same check loses nothing', async t => {
  const { jira, tracker, notes } = await trackedSetup(t, 'WEB-1', 'WEB-2');
  jira.remove('WEB-1');
  jira.change('WEB-2', { field: 'status', from: 'To Do', to: 'Done', author: jira.people.alex });
  const real = tracker.getClient;
  tracker.getClient = () => ({ ...real(), changelog: async () => { throw Object.assign(new Error('No connection to Jira.'), { code: 'network' }); } });
  assert.equal((await tracker.check()).ok, false);
  const gone = tracker.find('WEB-1');
  assert.deepEqual(gone.changes, []);
  assert.equal(gone.missingSince, undefined);
  assert.equal(notes.length, 0);

  tracker.getClient = real;
  assert.deepEqual(await tracker.check(), { ok: true, found: 2 });
  assert.deepEqual(gone.changes.map(c => c.field), ['gone']);
  assert.deepEqual(notes.map(n => n.key).sort(), ['WEB-1', 'WEB-2']);
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
  assert.equal(merged.version, 4);
  // fresh install
  const fresh = ensureShape({});
  assert.deepEqual(fresh.settings.excluded, []);
  assert.deepEqual(fresh.settings.excludedProjects, []);
  assert.equal(fresh.settings.notesProject, '');
  assert.equal('excludeBacklog' in fresh.settings, false);
  assert.equal(fresh.version, 4);
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
  assert.equal(v2.version, 4);
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
  assert.deepEqual(notes.pop(), { title: 'WEB-1 changed', subtitle: 'Mentions', body: 'Sam Rivera mentioned you on WEB-1', key: 'WEB-1' });
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
