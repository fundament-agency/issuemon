'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createJiraClient, normalizeBaseUrl, pickIssueType, JiraError } = require('../src/main/jira');
const { createMockJira } = require('./support/mock-jira');
const { createTranslator } = require('../src/shared/i18n');

const DAY = 86_400_000;

test('normalizeBaseUrl refuses plain http except for local hosts', () => {
  assert.equal(normalizeBaseUrl('http://example.atlassian.net'), '');
  assert.equal(normalizeBaseUrl('HTTP://example.atlassian.net/browse/WEB-1'), '');
  assert.equal(normalizeBaseUrl('http://localhost.example.com'), '');
  assert.equal(normalizeBaseUrl('http://127.0.0.1.example.com'), '');
  assert.equal(normalizeBaseUrl('https://example.atlassian.net'), 'https://example.atlassian.net');
});

test('normalizeBaseUrl', () => {
  assert.equal(normalizeBaseUrl('example.atlassian.net'), 'https://example.atlassian.net');
  assert.equal(normalizeBaseUrl('https://example.atlassian.net/browse/WEB-1 '), 'https://example.atlassian.net');
  assert.equal(normalizeBaseUrl('http://localhost:4778/'), 'http://localhost:4778');
  assert.equal(normalizeBaseUrl(''), '');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:1'), 'http://127.0.0.1:1');
  assert.equal(normalizeBaseUrl('http://[::1]:4778/'), 'http://[::1]:4778');
});

test('pickIssueType: Task or a localised name, otherwise the first plain type', () => {
  const epic = { id: '1', name: 'Epic', hierarchyLevel: 1 };
  const bug = { id: '2', name: 'Bug', hierarchyLevel: 0 };
  const taak = { id: '3', name: 'Taak', hierarchyLevel: 0 };
  const sub = { id: '4', name: 'Sub-task', subtask: true, hierarchyLevel: -1 };
  assert.equal(pickIssueType([epic, bug, taak, sub]), taak);
  assert.equal(pickIssueType([epic, sub, bug]), bug);
  assert.equal(pickIssueType([{ id: '5', name: 'Task' }]).id, '5'); // older sites without hierarchyLevel
  assert.equal(pickIssueType([epic, sub]), null);
});

test('an invalid URL is a config error, in the language of the translator', () => {
  assert.throws(() => createJiraClient({ baseUrl: '', email: 'a', token: 'b' }), err => err.code === 'config' && err.message === 'Invalid Jira URL.');
  assert.throws(() => createJiraClient({ baseUrl: '', email: 'a', token: 'b', t: createTranslator('nl') }), err => err.message === 'Ongeldige Jira-URL.');
});

test('Jira client against the mock Jira', async t => {
  const jira = createMockJira({ email: 'user@example.com', token: 'tok' });
  const url = await jira.start();
  t.after(() => jira.stop());
  const client = createJiraClient({ baseUrl: url, email: 'user@example.com', token: 'tok' });

  await t.test('myself', async () => {
    assert.deepEqual(await client.myself(), { accountId: 'acc-me', name: 'Demo User', email: 'user@example.com' });
  });

  await t.test('users: only active people, by name, across all pages', async () => {
    const people = await client.users();
    assert.deepEqual(people.map(p => p.name), ['Alex Morgan', 'Demo User', 'Jordan Lee', 'Priya Patel', 'Sam Rivera']); // no app, no former colleague
    assert.deepEqual(people[4], { accountId: 'acc-sam', name: 'Sam Rivera' });
    for (let n = 1; n <= 150; n++) jira.users.push({ accountId: `acc-${n}`, displayName: `Colleague ${String(n).padStart(3, '0')}`, accountType: 'atlassian', active: true });
    const before = jira.requests.length;
    assert.equal((await client.users()).length, 155);
    assert.equal(jira.requests.length - before, 3); // 100 + 57 + an empty page
    jira.users.push({ accountId: 'acc-nameless', accountType: 'atlassian', active: true });
    assert.deepEqual((await client.users()).find(p => p.accountId === 'acc-nameless'), { accountId: 'acc-nameless', name: 'Unknown' });
    const dutch = createJiraClient({ baseUrl: url, email: 'user@example.com', token: 'tok', t: createTranslator('nl') });
    assert.equal((await dutch.users()).find(p => p.accountId === 'acc-nameless').name, 'Onbekend');
    jira.users.splice(7); // back to the regular people
    jira.usersForbidden = true;
    await assert.rejects(client.users(), err => err.code === 'forbidden' && /browse users/.test(err.message));
    jira.usersForbidden = false;
  });

  await t.test('wrong token gives an auth error', async () => {
    const bad = createJiraClient({ baseUrl: url, email: 'user@example.com', token: 'wrong' });
    await assert.rejects(bad.myself(), err => err instanceof JiraError && err.code === 'auth' && err.status === 401
      && err.message === 'Login failed: check your email address and API token.');
    const dutch = createJiraClient({ baseUrl: url, email: 'user@example.com', token: 'wrong', t: createTranslator('nl') });
    await assert.rejects(dutch.myself(), err => err.message === 'Inloggen mislukt: controleer je e-mailadres en API-token.');
  });

  await t.test('no server gives a network error', async () => {
    const dead = createJiraClient({ baseUrl: 'http://127.0.0.1:1', email: 'a', token: 'b', timeoutMs: 2000 });
    await assert.rejects(dead.myself(), err => err.code === 'network' && err.message === 'No connection to 127.0.0.1:1.');
  });

  await t.test('bulkFetch leaves out unknown keys', async () => {
    jira.addIssue({ key: 'WEB-1', summary: 'One', status: 'Review' });
    const { issues } = await client.bulkFetch(['WEB-1', 'WEB-404']);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].key, 'WEB-1');
    assert.equal(issues[0].statusCat, 'indeterminate');
    const req = jira.requests.at(-1);
    assert.equal(req.path, '/rest/api/3/issue/bulkfetch');
    assert.ok(req.body.fields.includes('updated'));
  });

  await t.test('bulkFetch reads the due date, and a duedate change updates it', async () => {
    jira.addIssue({ key: 'WEB-2', summary: 'Two', duedate: '2026-10-16' });
    assert.equal((await client.bulkFetch(['WEB-2'])).issues[0].due, '2026-10-16');
    assert.ok(jira.requests.at(-1).body.fields.includes('duedate'));
    jira.change('WEB-2', { field: 'duedate', from: '2026-10-16', to: '2026-10-30' });
    assert.equal((await client.bulkFetch(['WEB-2'])).issues[0].due, '2026-10-30');
    jira.change('WEB-2', { field: 'duedate', from: '2026-10-30', to: null });
    assert.equal((await client.bulkFetch(['WEB-2'])).issues[0].due, null);
    assert.equal((await client.bulkFetch(['WEB-1'])).issues[0].due, null);
  });

  await t.test('bulkFetch throws on a 200 without a list of issues, as a transient error', async () => {
    for (const body of [{}, '', null, { issues: {} }]) {
      jira.bulkfetchBody = body;
      await assert.rejects(client.bulkFetch(['WEB-1']), err => err.name === 'JiraError' && !err.code && !err.status && /Jira/.test(err.message), JSON.stringify(body));
    }
    jira.bulkfetchBody = undefined;
  });

  await t.test('bulkFetch returns the issueErrors too, and none for an unknown key', async () => {
    const plain = await client.bulkFetch(['WEB-1', 'WEB-404']);
    assert.deepEqual(plain.errors, []); // a missing issue is just left out
    jira.issueErrorIds = ['WEB-1'];
    const { issues, errors } = await client.bulkFetch(['WEB-1', 'WEB-404']);
    jira.issueErrorIds = [];
    assert.equal(issues.length, 0);
    assert.deepEqual(errors.map(e => e.id), ['WEB-1']);
  });

  await t.test('bulkFetch requests the description, search does not', async () => {
    jira.addIssue({ key: 'WEB-2', summary: 'Twee', description: 'Wat er speelt' });
    const { issues } = await client.bulkFetch(['WEB-2']);
    assert.equal(issues[0].description, 'Wat er speelt');
    assert.ok(jira.requests.at(-1).body.fields.includes('description'));
    await client.search('assignee = currentUser()');
    const req = jira.requests.at(-1);
    assert.equal(req.path, '/rest/api/3/search/jql');
    assert.ok(!req.body.fields.includes('description'));
    jira.remove('WEB-2');
  });

  await t.test('changelog gives the last 100 for a long history', async () => {
    jira.addIssue({ key: 'WEB-2', summary: 'Druk' });
    for (let n = 0; n < 130; n++) jira.change('WEB-2', { field: 'summary', from: `v${n}`, to: `v${n + 1}`, at: 1_000 + n });
    const values = await client.changelog('WEB-2');
    assert.equal(values.length, 100);
    assert.equal(values.at(-1).items[0].toString, 'v130');
    assert.equal(values[0].items[0].toString, 'v31');
  });

  await t.test('changelog and comments throw on a 200 without the list or without JSON, as a transient error', async () => {
    for (const [body, call] of [['{}', 'changelog'], ['{"values":null}', 'changelog'], ['{}', 'comment'], ['<html>Sign in</html>', 'comment'], ['', 'changelog']]) {
      jira.fail(call, { status: 200, body });
      await assert.rejects(call === 'comment' ? client.comments('WEB-1') : client.changelog('WEB-1'),
        err => err.name === 'JiraError' && !err.code && !err.status && err.message.includes(call), body);
    }
  });

  await t.test('the second page of a long history without its list is unreadable too', async () => {
    jira.addIssue({ key: 'WEB-3', summary: 'Druk' });
    for (let n = 0; n < 130; n++) jira.comment('WEB-3', `c${n}`, jira.people.alex, 1_000 + n);
    const noSecondList = createJiraClient({
      baseUrl: jira.url, email: 'user@example.com', token: 'tok',
      fetch: (u, init) => (new URL(u).searchParams.get('startAt') === '30' ? Promise.resolve(new Response('{"total":130}', { status: 200 })) : fetch(u, init)),
    });
    await assert.rejects(noSecondList.comments('WEB-3'), err => err.name === 'JiraError' && !err.code && !err.status && err.message.includes('comment'));
    assert.equal((await client.comments('WEB-3')).length, 100);
  });

  await t.test('comments', async () => {
    jira.comment('WEB-1', 'Hallo');
    const comments = await client.comments('WEB-1');
    assert.equal(comments.length, 1);
  });

  await t.test('sends its own User-Agent (otherwise Jira rejects POST as XSRF)', async () => {
    const named = createJiraClient({ baseUrl: url, email: 'user@example.com', token: 'tok', userAgent: 'IssueMon/9.9.9' });
    await named.search('assignee = currentUser()');
    assert.equal(jira.requests.at(-1).headers['user-agent'], 'IssueMon/9.9.9');
  });

  await t.test('403 with plain text: the message names the request and the reason', async () => {
    const browserish = createJiraClient({ baseUrl: url, email: 'user@example.com', token: 'tok', userAgent: 'Mozilla/5.0 Chrome Electron' });
    await assert.rejects(browserish.search('assignee = currentUser()'), err =>
      err.code === 'forbidden' && err.message === 'No access (POST /rest/api/3/search/jql): XSRF check failed');
  });

  await t.test('search (stale query)', async () => {
    const me = jira.people.me;
    jira.addIssue({ key: 'OLD-1', summary: 'old', assignee: me, updated: Date.now() - 20 * DAY });
    jira.addIssue({ key: 'OLD-2', summary: 'old but done', status: 'Done', assignee: me, updated: Date.now() - 20 * DAY });
    jira.addIssue({ key: 'NEW-1', summary: 'vers', assignee: me, updated: Date.now() - DAY });
    const found = await client.search('assignee = currentUser() AND statusCategory != Done AND status NOT IN ("Closed") AND updated <= -14d ORDER BY updated DESC');
    assert.deepEqual(found.issues.map(i => i.key), ['OLD-1']);
    assert.equal(found.truncated, false);
  });

  await t.test('createIssue: Task in the project, without a sprint', async () => {
    const created = await client.createIssue({ project: 'OPS', summary: 'Cookie banner covers the footer' });
    assert.equal(created.key, 'OPS-1');
    const req = jira.requests.at(-1);
    assert.equal(req.method, 'POST');
    assert.equal(req.path, '/rest/api/3/issue');
    assert.deepEqual(req.body, { fields: { project: { key: 'OPS' }, issuetype: { id: '10002' }, summary: 'Cookie banner covers the footer' } });
    assert.equal(jira.issues.get('OPS-1').fields.type, 'Task');
    assert.equal((await client.createIssue({ project: 'OPS', summary: 'Tweede' })).key, 'OPS-2');
  });

  await t.test('issueTypes: only plain types, no epic or subtask', async () => {
    assert.deepEqual(await client.issueTypes('OPS'), [{ id: '10001', name: 'Story' }, { id: '10002', name: 'Task' }, { id: '10003', name: 'Bug' }]);
    await assert.rejects(client.issueTypes('NOPE'), err => err.message === 'Project NOPE does not exist, or you may not create issues in it.');
  });

  await t.test('createIssue: with typeId, and an unknown or unsuitable type falls back to Task', async () => {
    await client.createIssue({ project: 'OPS', summary: 'A bug', typeId: '10003' });
    assert.equal(jira.requests.at(-1).body.fields.issuetype.id, '10003');
    await client.createIssue({ project: 'OPS', summary: 'Onbekend', typeId: '99999' });
    assert.equal(jira.requests.at(-1).body.fields.issuetype.id, '10002');
    await client.createIssue({ project: 'OPS', summary: 'Epic not allowed', typeId: '10000' });
    assert.equal(jira.requests.at(-1).body.fields.issuetype.id, '10002');
  });

  await t.test('createIssue: unknown project gives a readable error', async () => {
    await assert.rejects(client.createIssue({ project: 'NOPE', summary: 'x' }), err =>
      err.code === 'not_found' && err.message === 'Project NOPE does not exist, or you may not create issues in it.');
  });

  await t.test('createIssue: a rejection from Jira comes through', async () => {
    await assert.rejects(client.createIssue({ project: 'OPS', summary: 'x'.repeat(300) }), err => err.status === 400
      && /^Jira rejected the request \(400, POST \/rest\/api\/3\/issue\): .*255/.test(err.message));
  });

  await t.test('search fetches all pages, up to the maximum', async () => {
    for (let n = 1; n <= 250; n++) jira.addIssue({ key: `BIG-${n}`, summary: `${n}`, assignee: jira.people.me, updated: Date.now() - (300 - n) * DAY });
    const before = jira.requests.length;
    const all = await client.search('assignee = currentUser()');
    assert.equal(all.issues.length, 253); // 250 + OLD-1, OLD-2, NEW-1
    assert.equal(all.truncated, false);
    assert.equal(jira.requests.length - before, 3); // 100 + 100 + 53
    const capped = await client.search('assignee = currentUser()', { max: 150 });
    assert.equal(capped.issues.length, 150);
    assert.equal(capped.truncated, true);
  });
});
