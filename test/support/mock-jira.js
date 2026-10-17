'use strict';
/* Mock Jira (Cloud REST v3, only what IssueMon uses). For tests, and to try the app without a real Jira:
 *   npm run mock-jira        → http://localhost:4778, email demo@example.com, token demo
 * http://localhost:4778/__mock has buttons to cause changes. */

const http = require('node:http');
const { version: APP_VERSION } = require('../../package.json');

const DAY = 86_400_000;
const CATEGORY = { 'To Do': 'new', Backlog: 'new', 'In Progress': 'indeterminate', Review: 'indeterminate', Test: 'indeterminate', Blocked: 'indeterminate', Closed: 'done', Done: 'done' };
const FLOW = ['To Do', 'In Progress', 'Review', 'Done'];
const ISSUE_TYPES = [
  { id: '10000', name: 'Epic', subtask: false, hierarchyLevel: 1 },
  { id: '10001', name: 'Story', subtask: false, hierarchyLevel: 0 },
  { id: '10002', name: 'Task', subtask: false, hierarchyLevel: 0 },
  { id: '10003', name: 'Bug', subtask: false, hierarchyLevel: 0 },
  { id: '10004', name: 'Sub-task', subtask: true, hierarchyLevel: -1 },
];
const jiraDate = ms => new Date(ms).toISOString().replace('Z', '+0000');
const adf = text => ({ type: 'doc', version: 1, content: String(text).split('\n\n').map(p => ({ type: 'paragraph', content: [{ type: 'text', text: p }] })) });

function createMockJira({ email = 'demo@example.com', token = 'demo', now = Date.now, projects = ['WEB', 'OPS'] } = {}) {
  const people = {
    me: { accountId: 'acc-me', displayName: 'Demo User', emailAddress: email },
    alex: { accountId: 'acc-alex', displayName: 'Alex Morgan' },
    sam: { accountId: 'acc-sam', displayName: 'Sam Rivera' },
    jordan: { accountId: 'acc-jordan', displayName: 'Jordan Lee' },
    priya: { accountId: 'acc-priya', displayName: 'Priya Patel' },
  };
  // Everyone on the site, as /users/search returns them: including an app and a former colleague, which IssueMon skips.
  const users = [
    ...Object.values(people).map(p => ({ ...p, accountType: 'atlassian', active: true })),
    { accountId: 'acc-bot', displayName: 'Automation for Jira', accountType: 'app', active: true },
    { accountId: 'acc-former', displayName: 'Former Colleague', accountType: 'atlassian', active: false },
  ];
  const issues = new Map();
  const removed = new Map(); // key → issue taken away by remove(), for restore()
  const requests = [];
  const projectKeys = new Set(projects); // where you may create issues; addIssue adds the project of the key
  let seq = 10_000;
  let server = null;

  function addIssue({ key, summary, status = 'To Do', type = 'Task', priority = 'Medium', assignee = null, updated = now(), labels = [], fixVersions = [], parent = null, subtasks = [], issuelinks = [], project, description = '' }) {
    const issue = {
      id: String(++seq),
      key,
      fields: {
        summary, status, type, priority, assignee, updated, labels, description, fixVersions, parent, subtasks, issuelinks,
        project: project || key.split('-')[0],
      },
      changelog: [],
      comments: [],
    };
    issues.set(key, issue);
    projectKeys.add(key.split('-')[0]);
    return issue;
  }

  /** POST /issue: same validation and error shape as Jira Cloud. */
  function createIssue(fields = {}) {
    const project = fields.project?.key;
    const type = mock.issueTypes.find(t => t.id === fields.issuetype?.id || t.name === fields.issuetype?.name);
    const summary = String(fields.summary ?? '');
    const errors = {};
    if (!projectKeys.has(project)) errors.project = 'valid project is required';
    if (!type) errors.issuetype = 'Specify an issue type';
    if (!summary.trim()) errors.summary = 'You must specify a summary of the issue.';
    else if (/[\r\n]/.test(summary)) errors.summary = 'The summary is invalid because it contains newline characters.';
    else if (summary.length > 255) errors.summary = 'Summary must be less than 255 characters.';
    if (Object.keys(errors).length) return { errors };
    const last = Math.max(0, ...[...issues.keys()].filter(k => k.startsWith(`${project}-`)).map(k => Number(k.split('-')[1])));
    return { issue: addIssue({ key: `${project}-${last + 1}`, summary, type: type.name, project }) };
  }

  const get = key => {
    const i = issues.get(key);
    if (!i) throw new Error(`Mock: unknown issue ${key}`);
    return i;
  };

  /** Field change, as Jira puts it in the changelog. */
  function change(key, { field, from, to, author = people.alex, at = now() }) {
    const i = get(key);
    const jiraField = { fixVersion: 'Fix Version', attachment: 'Attachment' }[field] || field;
    i.changelog.push({ id: String(++seq), author, created: at, items: [{ field: jiraField, fieldtype: 'jira', fromString: from ?? null, toString: to ?? null }] });
    const f = i.fields;
    if (field === 'status' || field === 'priority' || field === 'summary') f[field] = to;
    if (field === 'assignee') f.assignee = Object.values(people).find(p => p.displayName === to) || null;
    if (field === 'labels') f.labels = to ? to.split(' ') : [];
    if (field === 'fixVersion') f.fixVersions = to ? [to] : [];
    f.updated = at;
    return i;
  }

  function comment(key, text, author = people.alex, at = now()) {
    const i = get(key);
    i.comments.push({ id: String(++seq), author, body: adf(text), created: at, updated: at });
    i.fields.updated = at;
    return i;
  }

  /** Edits a comment, as Jira does: new body, `updated` and `updateAuthor` on the comment, and `updated` on the issue. */
  function editComment(key, commentId, text, author = people.alex, at = now()) {
    const i = get(key);
    const c = i.comments.find(x => x.id === String(commentId));
    if (!c) throw new Error(`Mock: unknown comment ${commentId} on ${key}`);
    Object.assign(c, { body: adf(text), updated: at, updateAuthor: author });
    i.fields.updated = at;
    return i;
  }

  /** Random change, for the demo. */
  function randomChange(key) {
    const i = key ? get(key) : [...issues.values()][Math.floor(Math.random() * issues.size)];
    const author = [people.alex, people.sam, people.jordan, people.priya][Math.floor(Math.random() * 4)];
    const roll = Math.random();
    const idx = FLOW.indexOf(i.fields.status);
    if (roll < 0.4 && idx >= 0 && idx < FLOW.length - 1) return change(i.key, { field: 'status', from: i.fields.status, to: FLOW[idx + 1], author });
    if (roll < 0.8) {
      const texts = ['Can you take a look at this today?', 'PR is ready for review.', 'Tested on staging, looks good.', 'Reproducible on Android, not on iOS.'];
      return comment(i.key, texts[Math.floor(Math.random() * texts.length)], author);
    }
    const prios = ['Highest', 'High', 'Medium', 'Low'].filter(p => p !== i.fields.priority);
    return change(i.key, { field: 'priority', from: i.fields.priority, to: prios[Math.floor(Math.random() * prios.length)], author });
  }

  // Shallow Jira relation payloads, without recursively expanding relations.
  function related(key) {
    const i = issues.get(key);
    if (!i) return { key };
    return { id: i.id, key, fields: {
      summary: i.fields.summary,
      status: { name: i.fields.status, statusCategory: { key: CATEGORY[i.fields.status] || 'indeterminate' } },
    } };
  }

  function toApi(i) {
    const f = i.fields;
    return {
      id: i.id,
      key: i.key,
      fields: {
        summary: f.summary,
        status: { name: f.status, statusCategory: { key: CATEGORY[f.status] || 'indeterminate' } },
        issuetype: { name: f.type, subtask: f.type === 'Sub-task' },
        priority: f.priority ? { name: f.priority } : null,
        assignee: f.assignee,
        updated: jiraDate(f.updated),
        labels: f.labels,
        parent: f.parent ? related(f.parent) : null,
        subtasks: f.subtasks.map(related),
        issuelinks: f.issuelinks.map(link => ({ ...link,
          ...(link.inwardIssue && { inwardIssue: related(link.inwardIssue) }),
          ...(link.outwardIssue && { outwardIssue: related(link.outwardIssue) }),
        })),
        description: f.description ? adf(f.description) : null,
        fixVersions: f.fixVersions.map(name => ({ name })),
        project: { key: i.key.split('-')[0], name: f.project },
      },
    };
  }

  function page(list, url, prop) {
    const startAt = Number(url.searchParams.get('startAt') || 0);
    const maxResults = Number(url.searchParams.get('maxResults') || 100);
    const values = list.slice(startAt, startAt + maxResults);
    return { [prop]: values, startAt, maxResults, total: list.length, isLast: startAt + values.length >= list.length };
  }

  function search(jql) {
    let list = [...issues.values()];
    const nobody = /assignee\s+IS\s+EMPTY/i.test(jql); // "(… OR assignee IS EMPTY)": issues without an assignee too
    if (/assignee\s*=\s*currentUser\(\)/i.test(jql)) list = list.filter(i => i.fields.assignee?.accountId === people.me.accountId || (nobody && !i.fields.assignee));
    const assignees = jql.match(/assignee\s+IN\s*\(([^)]*)\)/i);
    if (assignees) {
      const ids = assignees[1].split(',').map(s => s.trim().replace(/^"|"$/g, ''));
      list = list.filter(i => ids.includes(i.fields.assignee?.accountId) || (nobody && !i.fields.assignee));
    }
    const notIn = jql.match(/status\s+NOT\s+IN\s*\(([^)]*)\)/i);
    if (notIn) {
      const ex = notIn[1].split(',').map(s => s.trim().replace(/^"|"$/g, '').toLowerCase());
      list = list.filter(i => !ex.includes(i.fields.status.toLowerCase()));
    }
    if (/statusCategory\s*!=\s*Done/i.test(jql)) list = list.filter(i => (CATEGORY[i.fields.status] || 'indeterminate') !== 'done');
    const days = jql.match(/updated\s*<=\s*-(\d+)d/i);
    if (days) list = list.filter(i => i.fields.updated <= now() - Number(days[1]) * DAY);
    const dir = /ORDER BY updated DESC/i.test(jql) ? -1 : 1;
    return list.sort((a, b) => dir * (a.fields.updated - b.fields.updated));
  }

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const notFound = res => json(res, 404, { errorMessages: ['Issue does not exist or you do not have permission to see it.'], errors: {} });

  async function handler(req, res) {
    const url = new URL(req.url, 'http://mock');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers: req.headers });

    if (url.pathname === '/__mock') return controlPage(res);
    if (url.pathname === '/__mock/change' && req.method === 'POST') {
      const i = randomChange(url.searchParams.get('key') || undefined);
      res.writeHead(303, { Location: '/__mock' });
      return res.end(i.key);
    }
    // The GitHub "latest release" endpoint, for the update check (ISSUEMON_UPDATE_URL); no authentication, like GitHub's.
    if (req.method === 'GET' && url.pathname === '/__releases/latest') {
      return json(res, 200, { tag_name: `v${mock.release}`, html_url: `https://github.com/fundament-agency/issuemon/releases/tag/v${mock.release}` });
    }
    const browse = url.pathname.match(/^\/browse\/([A-Z0-9_]+-\d+)$/);
    if (browse) {
      const i = issues.get(browse[1]);
      res.writeHead(i ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<h1>${browse[1]}</h1><p>${i ? i.fields.summary : 'Does not exist'}</p><p>(mock Jira)</p>`);
    }

    // Like Jira Cloud: a POST with a browser User-Agent is rejected as XSRF (plain text, no JSON).
    if (req.method === 'POST' && /Mozilla\//.test(req.headers['user-agent'] || '')) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('XSRF check failed');
    }
    if (req.headers.authorization !== `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`) {
      return json(res, 401, { errorMessages: ['Client must be authenticated to access this resource.'] });
    }

    if (req.method === 'GET' && url.pathname === '/rest/api/3/myself') {
      if (mock.myselfStatus) return json(res, mock.myselfStatus, { errorMessages: ['Mock: /myself fails.'] });
      return json(res, 200, people.me);
    }
    if (req.method === 'GET' && url.pathname === '/rest/api/3/users/search') {
      if (mock.usersForbidden) return json(res, 403, { errorMessages: ['You do not have the permission to browse users.'] });
      const startAt = Number(url.searchParams.get('startAt') || 0);
      return json(res, 200, mock.users.slice(startAt, startAt + Number(url.searchParams.get('maxResults') || 50)));
    }
    if (req.method === 'POST' && url.pathname === '/rest/api/3/issue/bulkfetch') {
      if (mock.bulkfetchBody !== undefined) return json(res, 200, mock.bulkfetchBody); // a 200 that is no real answer, such as a proxy's
      const wanted = body?.issueIdsOrKeys || [];
      // Like Jira Cloud (spec: BulkIssueResults.issueErrors): an issue that doesn't exist or that you may not see is simply left out,
      // and issueErrors is empty. Only an issue Jira can't return for a retriable reason is named there, with its id.
      const failing = wanted.filter(w => mock.issueErrorIds.includes(w));
      const found = [...issues.values()].filter(i => (wanted.includes(i.key) || wanted.includes(i.id)) && !failing.includes(i.key) && !failing.includes(i.id));
      const issueErrors = failing.map(id => ({ id, errorMessage: 'Jira could not fetch this issue right now. Try again later.' }));
      return json(res, 200, { issues: found.map(toApi), issueErrors });
    }
    const meta = url.pathname.match(/^\/rest\/api\/3\/issue\/createmeta\/([^/]+)\/issuetypes$/);
    if (req.method === 'GET' && meta) {
      const project = decodeURIComponent(meta[1]);
      if (!projectKeys.has(project)) return json(res, 404, { errorMessages: [`No project could be found with key '${project}'.`], errors: {} });
      return json(res, 200, { issueTypes: mock.issueTypes, maxResults: 50, startAt: 0, total: mock.issueTypes.length });
    }
    if (req.method === 'POST' && url.pathname === '/rest/api/3/issue') {
      const { issue, errors } = createIssue(body?.fields);
      if (errors) return json(res, 400, { errorMessages: [], errors });
      return json(res, 201, { id: issue.id, key: issue.key, self: `${mock.url}/rest/api/3/issue/${issue.id}` });
    }
    if (req.method === 'POST' && url.pathname === '/rest/api/3/search/jql') {
      const jql = body?.jql || '';
      const known = new Set([...Object.keys(CATEGORY), ...[...issues.values()].map(i => i.fields.status)].map(s => s.toLowerCase()));
      const named = (jql.match(/status\s+NOT\s+IN\s*\(([^)]*)\)/i)?.[1] || '').split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
      const unknown = named.filter(s => !known.has(s.toLowerCase()));
      if (unknown.length) return json(res, 400, { errorMessages: unknown.map(s => `The value '${s}' does not exist for the field 'status'.`), errors: {} });
      const all = search(jql);
      const start = Number(body?.nextPageToken || 0);
      const size = Math.min(body?.maxResults || 50, 100);
      const next = start + size < all.length ? String(start + size) : null;
      return json(res, 200, { issues: all.slice(start, start + size).map(toApi), isLast: !next, ...(next && { nextPageToken: next }) });
    }
    const m = url.pathname.match(/^\/rest\/api\/3\/issue\/([^/]+)\/(changelog|comment)$/);
    if (req.method === 'GET' && m) {
      const i = issues.get(decodeURIComponent(m[1])) || [...issues.values()].find(x => x.id === m[1]);
      if (!i) return notFound(res);
      if (m[2] === 'changelog') {
        const values = i.changelog.map(h => ({ ...h, created: jiraDate(h.created) }));
        return json(res, 200, page(values, url, 'values'));
      }
      const comments = i.comments.map(c => ({ ...c, created: jiraDate(c.created), updated: jiraDate(c.updated) }));
      return json(res, 200, page(comments, url, 'comments'));
    }
    return json(res, 404, { errorMessages: [`Mock: no route for ${req.method} ${url.pathname}`] });
  }

  function controlPage(res) {
    const rows = [...issues.values()].map(i => `<tr><td><b>${i.key}</b></td><td>${i.fields.summary}</td><td>${i.fields.status}</td>
      <td>${i.fields.assignee?.displayName || '—'}</td><td><form method="post" action="/__mock/change?key=${i.key}"><button>Make a change</button></form></td></tr>`).join('');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>Mock Jira</title>
      <style>body{font:14px system-ui;margin:24px}td{padding:4px 10px;border-bottom:1px solid #ddd}</style>
      <h1>Mock Jira</h1><p>Sign in to IssueMon with URL <code>http://localhost:${server?.address()?.port}</code>, email <code>${email}</code>, token <code>${token}</code>.</p>
      <p>Update check: start IssueMon with <code>ISSUEMON_UPDATE_URL=http://localhost:${server?.address()?.port}/__releases/latest</code> (reports release ${mock.release}).</p>
      <table>${rows}</table>`);
  }

  const mock = {
    people,
    issues,
    requests,
    issueTypes: [...ISSUE_TYPES], // can be changed per test
    users,
    usersForbidden: false,
    myselfStatus: null, // HTTP status for GET /myself instead of the user, e.g. 500
    bulkfetchBody: undefined, // a body to answer every bulkfetch with (status 200), e.g. {} like a proxy would
    issueErrorIds: [], // ids or keys that bulkfetch leaves out of issues and names in issueErrors, as for a retriable error
    release: APP_VERSION, // the latest release the update check sees; the running version means "up to date"
    addIssue,
    change,
    comment,
    editComment,
    randomChange,
    /** The issue is deleted, or you lost access to it: bulkfetch leaves it out. */
    remove: key => { if (issues.has(key)) removed.set(key, issues.get(key)); return issues.delete(key); },
    /** Undoes remove(): the same issue (same id) is back. */
    restore: key => { const i = removed.get(key); if (i) { issues.set(key, i); removed.delete(key); } return !!i; },
    get url() { return `http://127.0.0.1:${server.address().port}`; },
    start(port = 0) {
      server = http.createServer((req, res) => handler(req, res).catch(err => json(res, 500, { errorMessages: [err.message] })));
      return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(this.url)));
    },
    stop() {
      return new Promise(resolve => (server ? server.close(() => resolve()) : resolve()));
    },
  };
  return mock;
}

/** Demo data for `npm run mock-jira` and the e2e tests; the e2e tests assert on it. */
function seedDemo(jira) {
  const t = Date.now();
  const { me, alex, sam, jordan, priya } = jira.people;
  jira.addIssue({ key: 'WEB-1423', type: 'Bug', summary: 'Checkout: card payment option disappears on mobile', status: 'In Progress', priority: 'High', assignee: sam, updated: t - 3 * DAY,
    labels: ['mobile', 'checkout'], fixVersions: ['2026.10'], parent: 'WEB-1398', subtasks: ['WEB-1100', 'APP-88'],
    issuelinks: [
      { type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, inwardIssue: 'OPS-310' },
      { type: { name: 'Relates', inward: 'relates to', outward: 'relates to' }, outwardIssue: 'APP-52' },
    ],
    description: 'On mobile (iOS and Android) the card payment option is missing from the list of payment methods.\n\nOnly for orders under 5 USD; everything is normal on desktop.' });
  jira.addIssue({ key: 'APP-88', type: 'Bug', summary: 'Push notifications arrive twice after signing in again', status: 'In Progress', priority: 'Medium', assignee: jordan, updated: t - 2 * DAY,
    description: 'After signing out and back in, the app registers the device twice, so every push arrives twice.' });
  jira.addIssue({ key: 'OPS-310', type: 'Task', summary: 'SSL certificate for api.example.com expires in 9 days', status: 'To Do', priority: 'Highest', assignee: me, updated: t - DAY });
  jira.addIssue({ key: 'WEB-1398', type: 'Story', summary: 'Search filter does not remember the chosen sort order', status: 'Review', priority: 'Medium', assignee: alex, updated: t - 4 * DAY });
  jira.addIssue({ key: 'WEB-1201', type: 'Bug', summary: 'Footer links to the old privacy policy', status: 'To Do', assignee: me, updated: t - 41 * DAY,
    description: 'The footer still points to /privacy-2019 instead of the new privacy policy.' });
  jira.addIssue({ key: 'APP-52', type: 'Bug', summary: 'Crash when opening a deep link without a session', status: 'In Progress', priority: 'High', assignee: me, updated: t - 23 * DAY });
  jira.addIssue({ key: 'OPS-240', type: 'Task', summary: 'Set up log rotation on worker-02', status: 'Blocked', priority: 'Low', assignee: me, updated: t - 17 * DAY });
  jira.addIssue({ key: 'WEB-1100', type: 'Task', summary: 'Remove the old campaign landing page', status: 'Done', priority: 'Low', assignee: me, updated: t - 60 * DAY });
  jira.addIssue({ key: 'APP-40', type: 'Story', summary: 'Rewrite the onboarding copy', status: 'Closed', assignee: me, updated: t - 90 * DAY });
  jira.addIssue({ key: 'WEB-1050', type: 'Story', summary: 'Search in the help desk', status: 'Backlog', priority: 'Low', assignee: me, updated: t - 70 * DAY });
  // Stale for colleagues: only visible once you tick them in Settings
  jira.addIssue({ key: 'WEB-1150', type: 'Bug', summary: 'Cookie notice is not translated to French', status: 'In Progress', assignee: sam, updated: t - 34 * DAY });
  jira.addIssue({ key: 'APP-61', type: 'Task', summary: 'Replace the screenshots in the App Store', status: 'Review', priority: 'Low', assignee: alex, updated: t - 26 * DAY });
  jira.addIssue({ key: 'OPS-199', type: 'Task', summary: 'Test backups of the staging database', status: 'To Do', assignee: alex, updated: t - 9 * DAY });
  // Without an assignee: only visible once you tick Unassigned in Settings; OPS-275 is too recent to be stale
  jira.addIssue({ key: 'WEB-1312', type: 'Story', summary: 'Newsletter signup shows no confirmation', status: 'To Do', priority: 'Medium', updated: t - 31 * DAY });
  jira.addIssue({ key: 'OPS-275', type: 'Task', summary: 'Set up alerts for the queue worker', status: 'To Do', updated: t - 5 * DAY });
  jira.change('WEB-1423', { field: 'assignee', from: 'Alex Morgan', to: 'Sam Rivera', author: alex, at: t - 3 * DAY });
  jira.comment('WEB-1201', 'Waiting for the legal check of the new text.', priya, t - 41 * DAY);
  jira.comment('APP-88', 'Seems to be related to the token refresh.', priya, t - 2 * DAY);
}

if (require.main === module) {
  const port = Number(process.env.PORT || 4778);
  const jira = createMockJira();
  seedDemo(jira);
  jira.start(port).then(url => {
    console.log(`Mock Jira running at ${url.replace('127.0.0.1', 'localhost')}`);
    console.log('In IssueMon → Settings: Jira URL http://localhost:%d, email demo@example.com, API token demo', port);
    console.log(`To cause changes, open http://localhost:${port}/__mock`);
  });
}

module.exports = { createMockJira, seedDemo, jiraDate };
