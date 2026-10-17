'use strict';
/* main/tracker.js against the mock Jira: random sequences of Jira activity and user actions, with transient network
 * failures, Jira changing while a check is running, and actions overlapping a check. After every step the tracker's
 * state must be consistent; at the end, after one clean check, every change in Jira must have reached IssueMon. */

const { ensureShape } = require('../../src/main/tracker');
const { adfToText } = require('../../src/main/changes');
const { createWorld, FAULTS } = require('../lib/world');
const { fail, same } = require('../lib/property');

const IGNORED = new Set(['Rank', 'WorklogId', 'timespent', 'timeestimate', 'timeoriginalestimate', 'WorklogTimeSpent', 'Worklog Id']);
const FIELDS = ['status', 'priority', 'summary', 'assignee', 'labels', 'fixVersion', 'attachment', 'Sprint', 'Rank', 'description', 'Story Points', 'timespent'];
const FLOW = ['To Do', 'In Progress', 'Review', 'Done', 'Closed'];
const PEOPLE = ['me', 'alex', 'sam', 'jordan', 'priya'];

/* ---------- generating a sequence ---------- */

function genOps(r, profile) {
  const jiraOp = () => r.weighted([
    [4, () => ({ op: 'jiraComment', issue: r.int(0, 20), author: r.int(0, 4), mention: r.weighted([[6, null], [2, 'me'], [1, 'sam']]), text: r.plainText(5) || 'ok' })],
    [4, () => ({ op: 'jiraChange', issue: r.int(0, 20), author: r.int(0, 4), field: r.pick(FIELDS), value: r.int(0, 99) })],
    [3, () => ({ op: 'jiraEdit', issue: r.int(0, 20), comment: r.int(0, 20), author: r.int(0, 4), kind: r.weighted([[3, 'text'], [1, 'same'], [1, 'mention']]), text: r.plainText(5) || 'edited' })],
    [1, () => ({ op: 'jiraAdd', project: r.pick(['WEB', 'OPS']) })],
    [1, () => ({ op: 'jiraRemove', issue: r.int(0, 20) })],
    [1, () => ({ op: 'jiraRestore' })],
    [1, () => ({ op: 'jiraMove', issue: r.int(0, 20), project: r.pick(['APP', 'WEB', 'OPS']), author: r.int(0, 4) })],
  ]);
  const trackerOp = () => r.weighted([
    [3, () => ({ op: 'track', issues: r.array(() => r.int(0, 20), 1, 3), form: r.pick(['key', 'url', 'lower']), unknown: r.bool(0.1) })],
    [4, () => ({ op: 'check' })],
    [2, () => ({ op: 'mark', tracked: r.array(() => r.int(0, 20), 1, 2) })],
    [1, () => ({ op: 'unmark' })],
    [1, () => ({ op: 'untrack', tracked: r.int(0, 20) })],
    [1, () => ({ op: 'restore' })],
    [1, () => ({ op: 'ignoreOwn', value: r.bool(0.7) })],
  ]);
  const pairs = [[5, jiraOp], [5, trackerOp]];
  if (profile.faults) {
    pairs.push(
      [2, () => ({ op: 'fault', endpoint: r.pick(['bulkfetch', 'changelog', 'comment', 'myself', 'search']), kind: r.pick(Object.keys(FAULTS)), count: r.int(1, 3) })],
      [2, () => ({ op: 'midCheck', endpoint: r.pick(['bulkfetch', 'changelog', 'comment', 'search']), then: jiraOp() })],
    );
  }
  if (profile.sites) {
    const switchOp = () => ({ op: 'switchSite', to: r.int(0, 1) });
    pairs.push([2, switchOp], [1, () => ({ op: 'midCheck', endpoint: r.pick(['bulkfetch', 'changelog', 'comment', 'myself', 'search']), then: switchOp() })]);
  }
  if (profile.concurrent) {
    // No undo inside an overlap: an undo of Processed can reopen a "no longer accessible" change that the overlapping
    // check just resolved. That is known, rare (the check must land inside the 5 s undo window) and not worth the noise.
    const overlapOp = () => { const o = trackerOp(); return o.op === 'unmark' ? { op: 'check' } : o; };
    pairs.push([3, () => {
      const ops = r.array(() => (r.bool(0.7) ? overlapOp() : jiraOp()), 1, 3);
      return { op: 'concurrent', ops, waits: ops.map(() => r.int(0, 8)) };
    }]);
  }
  const dt = () => r.weighted([[5, () => r.int(1, 1000)], [3, () => r.int(1000, 120_000)], [1, () => r.int(1, 3)]]);
  const ops = [{ op: 'track', issues: [0, 1, 2, 3], form: 'key', unknown: false }, ...r.array(() => r.weighted(pairs), 8, profile.length)];
  return ops.map(o => ({ ...o, dt: dt() }));
}

/* ---------- running a sequence ---------- */

async function seed(world, ctx) {
  const { jira, clock } = world;
  const day = 86_400_000;
  for (const [key, ago] of [['WEB-1', 9], ['WEB-2', 5], ['OPS-1', 3], ['OPS-2', 20]]) {
    jira.addIssue({ key, summary: `Issue ${key}`, status: 'To Do', assignee: jira.people.alex, updated: clock.t - ago * day });
    ctx.counters[key.split('-')[0]] = Math.max(ctx.counters[key.split('-')[0]] || 0, Number(key.split('-')[1]));
  }
  // History from before tracking starts: none of it may be reported.
  comment(world, ctx, 'WEB-1', 'Older comment', jira.people.sam, clock.t - 8 * day, []);
  comment(world, ctx, 'OPS-1', 'Older comment on ops', jira.people.me, clock.t - 2 * day, [jira.people.me]);
  jira.change('WEB-2', { field: 'status', from: 'To Do', to: 'In Progress', author: jira.people.sam, at: clock.t - 4 * day });
  // A second site (another client's Jira): its own account, and issue ids that start at 10001 like every Jira site's.
  const other = world.sites[1];
  if (other) {
    Object.assign(other.people.me, { accountId: 'acc-me-site-b', displayName: 'Me on site B' });
    for (let n = 1; n <= 8; n++) other.addIssue({ key: `HR-${n}`, summary: `Site B issue ${n}`, status: 'To Do', updated: clock.t - n * day });
  }
}

function comment(world, ctx, key, text, author, at, mentions) {
  const issue = world.jira.comment(key, text, author, at, mentions);
  ctx.texts.set(issue.comments.at(-1).id, { text, mentions });
}

const issuesOf = jira => [...jira.issues.values()].sort((a, b) => Number(a.id) - Number(b.id));
const pickIssue = (jira, n) => { const list = issuesOf(jira); return list.length ? list[n % list.length] : null; };
const nextKey = (ctx, project) => `${project}-${(ctx.counters[project] = (ctx.counters[project] || 0) + 1)}`;

function switchSite(world, ctx, o) {
  ctx.active = o.to;
  ctx.switches++;
  world.tracker.saveSettings({ baseUrl: world.sites[o.to].url, token: 'tok' }); // another host clears the token unless the patch brings one
}

function jiraOp(world, ctx, o) {
  if (o.op === 'switchSite') return switchSite(world, ctx, o);
  const { jira, clock } = world;
  const person = n => jira.people[PEOPLE[n % PEOPLE.length]];
  const at = ++clock.t; // every Jira event has a time of its own, later than everything before it
  if (o.op === 'jiraAdd') {
    jira.addIssue({ key: nextKey(ctx, o.project), summary: 'New issue', status: 'To Do', updated: at });
    return;
  }
  if (o.op === 'jiraRestore') {
    const key = ctx.removed.pop();
    if (key && !jira.issues.has(key)) jira.restore(key);
    return;
  }
  const i = pickIssue(jira, o.issue);
  if (!i) return;
  switch (o.op) {
    case 'jiraComment': {
      const mentions = o.mention ? [jira.people[o.mention]] : [];
      comment(world, ctx, i.key, o.text, person(o.author), at, mentions);
      return;
    }
    case 'jiraChange': {
      const f = i.fields;
      const values = {
        status: () => [f.status, FLOW.filter(s => s !== f.status)[o.value % 4]],
        priority: () => [f.priority, ['Highest', 'High', 'Low', 'Lowest'].filter(p => p !== f.priority)[o.value % 3]],
        summary: () => [f.summary, `Summary ${o.value}`],
        assignee: () => [f.assignee?.displayName || null, [null, 'Demo User', 'Alex Morgan', 'Sam Rivera'][o.value % 4]],
        labels: () => [f.labels.join(' ') || null, `label${o.value}`],
        fixVersion: () => [f.fixVersions[0] || null, `2026.${o.value}`],
        attachment: () => (o.value % 2 ? ['old.png', null] : [null, `file${o.value}.png`]),
        Sprint: () => [null, `Sprint ${o.value}`],
        Rank: () => [null, 'Ranked higher'],
        description: () => ['old text', `new text ${o.value}`],
        'Story Points': () => [null, String(o.value)],
        timespent: () => [null, String(o.value * 60)],
      };
      const [from, to] = values[o.field]();
      jira.change(i.key, { field: o.field, from, to, author: person(o.author), at });
      return;
    }
    case 'jiraEdit': {
      if (!i.comments.length) return;
      const c = i.comments[o.comment % i.comments.length];
      const prev = ctx.texts.get(c.id);
      const text = o.kind === 'text' ? o.text : prev.text;
      const mentions = o.kind === 'mention' ? (prev.mentions.length ? [] : [jira.people.me]) : prev.mentions;
      jira.editComment(i.key, c.id, text, person(o.author), at, mentions);
      ctx.texts.set(c.id, { text, mentions });
      return;
    }
    case 'jiraRemove':
      jira.remove(i.key);
      ctx.removed.push(i.key);
      return;
    case 'jiraMove': {
      const old = i.key;
      const key = nextKey(ctx, o.project);
      jira.issues.delete(old);
      Object.assign(i, { key });
      i.fields.project = o.project;
      i.changelog.push({ id: String(900_000 + ++ctx.historySeq), author: person(o.author), created: at, items: [{ field: 'Key', fieldtype: 'jira', fromString: old, toString: key }] });
      i.fields.updated = at;
      jira.issues.set(key, i);
      world.net.aliases.set(old, i);
      return;
    }
    default:
      throw new Error(`unknown Jira op ${o.op}`);
  }
}

/** Notification rule (README, Notifications): up to 3 changed issues one each, more give a single summary. */
function checkNotifications(world, before) {
  const calls = world.announced.slice(before.announced);
  const sent = world.notifications.slice(before.notifications);
  if (calls.length > 1) fail('announced-twice', `one check announced ${calls.length} times`);
  const fresh = calls[0] || [];
  const want = fresh.length > 3 ? 1 : fresh.length;
  if (sent.length !== want) fail('notification-count', `${fresh.length} changed issues gave ${sent.length} notifications, expected ${want}`, { sent });
  if (fresh.length > 3 && sent[0].key !== null) fail('summary-key', 'a summary notification opens one issue', { sent });
  if (fresh.length <= 3 && sent.some((n, i) => n.key !== fresh[i].key)) fail('notification-key', 'a notification opens another issue than it is about', { sent, fresh: fresh.map(f => f.key) });
}

/** Undo (⌘Z, the toast) is for the last action and lives 5 s: any other user action in between ends it here. */
const UNDO_KEEPS = { mark: ['unmark'], untrack: ['restore'] };

async function trackerOp(world, ctx, o, { strict }) {
  const { tracker, jira } = world;
  if (!(UNDO_KEEPS[ctx.lastUserOp] || []).includes(o.op)) { ctx.lastMarked = []; ctx.untracked = []; }
  ctx.lastUserOp = o.op;
  const tracked = () => tracker.data.tracked.filter(t => !t.loading);
  switch (o.op) {
    case 'track': {
      const site = world.sites[ctx.active];
      const keys = [...new Set(o.issues.map(n => pickIssue(site, n)?.key).filter(Boolean))];
      if (o.unknown) keys.push('ZZZ-9');
      const text = o.form === 'url' ? keys.map(k => `https://acme.atlassian.net/browse/${k}`).join('\n') : o.form === 'lower' ? keys.join(', ').toLowerCase() : keys.join(' ');
      const res = await tracker.addIssues(text);
      // Jira may change during the request (a midCheck op): only a key that existed before and after counts.
      const existed = keys.filter(k => site.issues.has(k));
      for (const key of res.added || []) {
        const t = tracker.find(key);
        if (t?.id) ctx.baselines.set(t.id, t.seenUntil);
        if (t) ctx.home.set(t, ctx.active);
      }
      if (strict && res.ok && res.notFound.some(k => existed.includes(k))) fail('track-not-found', `an issue that exists was reported as not found: ${res.notFound}`, { res });
      return;
    }
    case 'check': {
      const before = { announced: world.announced.length, notifications: world.notifications.length };
      const res = await tracker.check();
      if (strict) {
        checkNotifications(world, before);
        const fresh = world.announced.slice(before.announced)[0] || [];
        if (res.ok && res.found !== fresh.reduce((n, f) => n + f.changes.length, 0)) fail('found-count', `check() says it found ${res.found} changes but announced others`, { res });
      }
      return;
    }
    case 'mark': {
      const list = tracked();
      if (!list.length) return;
      const keys = o.tracked.map(n => list[n % list.length].key);
      ctx.lastMarked = tracker.markProcessed(keys);
      if (strict) for (const key of keys) if (tracker.find(key)?.changes.some(c => !c.processed)) fail('mark-left-pending', `${key} still has pending changes after Processed`);
      return;
    }
    case 'unmark': {
      tracker.unmark(ctx.lastMarked);
      const ids = new Set(ctx.lastMarked);
      if (strict) for (const t of tracker.data.tracked) for (const c of t.changes) if (ids.has(c.id) && c.processed) fail('unmark-left-processed', `undo of Processed left ${c.id} processed`);
      ctx.lastMarked = [];
      return;
    }
    case 'untrack': {
      const list = tracked();
      if (!list.length) return;
      const entry = list[o.tracked % list.length];
      const index = tracker.data.tracked.indexOf(entry);
      if (tracker.untrack(entry.key)) ctx.untracked.push({ key: entry.key, index, entry });
      return;
    }
    case 'restore': {
      const u = ctx.untracked.pop();
      if (!u) return;
      const length = tracker.data.tracked.length;
      const ok = tracker.restore(u.key);
      if (strict && ok && tracker.data.tracked.indexOf(u.entry) !== Math.min(u.index, length)) fail('restore-position', 'Undo of Stop tracking put the issue elsewhere in the list');
      return;
    }
    case 'ignoreOwn':
      tracker.saveSettings({ ignoreOwn: o.value });
      return;
    default:
      throw new Error(`unknown tracker op ${o.op}`);
  }
}

async function step(world, ctx, o, { strict = true } = {}) {
  world.clock.t += Math.max(1, o.dt || 1);
  if (o.op.startsWith('jira') || o.op === 'switchSite') return jiraOp(world, ctx, o);
  if (o.op === 'fault') {
    if (o.count > 0) world.net.faults.push({ endpoint: o.endpoint, kind: o.kind, left: o.count });
    return;
  }
  if (o.op === 'midCheck') {
    world.net.hooks.push({ endpoint: o.endpoint, run: () => jiraOp(world, ctx, o.then) });
    return;
  }
  if (o.op === 'concurrent') {
    const running = [world.tracker.check()];
    for (const [i, sub] of o.ops.entries()) {
      for (let w = 0; w < (o.waits[i] || 0); w++) await new Promise(resolve => setImmediate(resolve));
      const p = step(world, ctx, sub, { strict: false });
      p.catch(() => {}); // observed below; without this a rejection during the waits counts as unhandled
      running.push(p);
    }
    const results = await Promise.allSettled(running);
    const broken = results.find(x => x.status === 'rejected' && x.reason?.name === 'Violation');
    if (broken) throw broken.reason;
    return;
  }
  return trackerOp(world, ctx, o, { strict });
}

/* ---------- invariants ---------- */

function checkShape(world) {
  const { data } = world.tracker;
  const keys = data.tracked.map(t => t.key);
  if (new Set(keys).size !== keys.length) fail('duplicate-key', `an issue is tracked twice: ${keys}`);
  const ids = data.tracked.map(t => t.id).filter(Boolean);
  if (new Set(ids).size !== ids.length) fail('duplicate-id', `one Jira issue is tracked twice under different keys: ${keys}`);
  if (data.tracked.some(t => t.loading)) fail('stuck-loading', 'an issue stays "loading" after every request finished');
  for (const t of data.tracked) {
    const changeIds = t.changes.map(c => c.id);
    if (new Set(changeIds).size !== changeIds.length) fail('duplicate-change', `${t.key} has the same change twice`, { ids: changeIds });
  }
  // Saving and loading the data file (JSON + ensureShape at startup) must not change anything.
  const saved = JSON.parse(JSON.stringify(data));
  const loaded = ensureShape(JSON.parse(JSON.stringify(data)));
  if (!same(loaded, saved)) {
    const diff = Object.keys(saved).filter(k => !same(saved[k], loaded[k]));
    fail('restart-changes-state', `restarting would change the stored ${diff.join(', ')}`, { before: diff.map(k => saved[k]), after: diff.map(k => loaded[k]) });
  }
}

/** Two sites: a tracked issue stays the issue it was on its own site (in the active list and in the saved ones), the Stale list and the identity are the connected site's. */
function checkSites(world, ctx) {
  if (world.sites.length < 2) return;
  for (const t of world.tracker.data.tracked) {
    const home = ctx.home.get(t);
    if (home == null || !t.issue) continue;
    const fromB = t.issue.summary.startsWith('Site B');
    if (fromB !== (home === 1)) fail('foreign-issue', `${t.key}, tracked on site ${'AB'[home]}, now shows "${t.issue.summary}" from the other site`, { id: t.id, key: t.key });
  }
  const { data } = world.tracker;
  const hostOf = n => new URL(world.sites[n].url).host;
  if (data.site !== hostOf(ctx.active)) fail('wrong-site', `connected to site ${'AB'[ctx.active]} but the tracked list is of ${data.site}`);
  // The lists of the sites we left: each holds only issues of its own site, and none is the active site's.
  for (const saved of data.sites) {
    if (saved.host === data.site) fail('saved-active-site', `the list of ${saved.host} is saved while it is the active one`);
    for (const t of saved.tracked) {
      const home = ctx.home.get(t);
      if (home == null || !t.issue) continue;
      if (saved.host !== hostOf(home)) fail('saved-foreign-list', `${t.key}, tracked on site ${'AB'[home]}, is saved under ${saved.host}`, { id: t.id, key: t.key });
      if (t.issue.summary.startsWith('Site B') !== (home === 1)) fail('foreign-issue', `${t.key}, tracked on site ${'AB'[home]}, now shows "${t.issue.summary}" from the other site`, { id: t.id, key: t.key });
    }
  }
  // The Stale list shown is the connected site's.
  if (data.stale.site !== data.site) fail('stale-foreign', `the Stale list is from ${data.stale.site}, the connected site is ${data.site}`);
  for (const i of data.stale.issues) if (String(i.summary).startsWith('Site B') !== (ctx.active === 1)) fail('stale-foreign', `the Stale list of site ${'AB'[ctx.active]} holds ${i.key}, "${i.summary}"`);
  const me = data.me;
  const want = world.sites[ctx.active].people.me.accountId;
  if (me && me.accountId !== want) fail('wrong-account', `connected to site ${'AB'[ctx.active]} but the identity is ${me.accountId}`);
}

/** Every change that arrived unprocessed (not your own) must have been part of a notification. */
function checkAnnounced(world, ctx) {
  for (const fresh of world.announced.slice(ctx.announcedSeen)) for (const f of fresh) for (const c of f.changes) ctx.notified.add(c);
  ctx.announcedSeen = world.announced.length;
  const switched = ctx.switches !== ctx.switchesSeen;
  const entries = [...world.tracker.data.tracked, ...[...world.tracker.removed.values()].map(r => r.entry)];
  for (const t of entries) {
    for (const c of t.changes) {
      if (ctx.seen.has(c)) continue;
      ctx.seen.add(c);
      // README: a check whose account changed while it ran may not notify (by design), even what it recorded before the switch.
      if (!c.processed && !c.own && !ctx.notified.has(c) && !switched) {
        fail('unannounced-change', `${t.key}: change ${c.id} (${c.field}) is pending in Changed but was never notified`, { change: { id: c.id, field: c.field, to: c.to } });
      }
    }
  }
  ctx.switchesSeen = ctx.switches;
}

/** After a clean check: every Jira event since an issue was tracked is a change in IssueMon, and stored comment texts are current. */
function checkComplete(world, ctx) {
  const { jira, tracker } = world;
  const byId = new Map(issuesOf(jira).map(i => [i.id, i]));
  for (const t of tracker.data.tracked) {
    const issue = byId.get(t.id);
    const exists = !!issue;
    if (exists === !!(t.error || t.missingSince)) fail('gone-state', `${t.key} ${exists ? 'exists in Jira but shows as missing' : 'is gone from Jira but shows no error'}`, { error: t.error, missingSince: t.missingSince });
    const openGone = t.changes.filter(c => c.field === 'gone' && !c.processed).length;
    if (exists ? openGone : openGone > 1) fail('gone-change', `${t.key} has ${openGone} open "no longer accessible" changes while it ${exists ? 'exists' : 'is gone'}`);
    const baseline = ctx.baselines.get(t.id);
    if (!issue || baseline == null) continue;
    if (issue.changelog.length > 100 || issue.comments.length > 100 || t.changes.filter(c => c.processed).length >= 55) continue; // documented limits
    const recorded = new Set(t.changes.map(c => c.id));
    const missing = [];
    for (const h of issue.changelog) {
      if (h.created <= baseline) continue;
      h.items.forEach((item, idx) => { if (!IGNORED.has(item.field) && !recorded.has(`h${h.id}-${idx}`)) missing.push(`${item.field} → ${item.toString}`); });
    }
    for (const c of issue.comments) if (c.created > baseline && !recorded.has(`c${c.id}`)) missing.push(`comment "${ctx.texts.get(c.id)?.text}"`);
    if (missing.length) fail('lost-change', `${t.key}: Jira has changes IssueMon never recorded: ${missing.join('; ')}`, { recorded: t.changes.map(c => c.id) });
    const texts = tracker.commentTexts(t);
    for (const c of issue.comments) {
      if (c.created <= baseline && c.updated <= baseline) continue;
      const want = adfToText(c.body); // the text with its mentions, as Jira returns it
      const got = texts.get(c.id)?.text;
      if (got !== want) fail('stale-comment-text', `${t.key}: IssueMon's latest text for comment ${c.id} is ${JSON.stringify(got)}, Jira's is ${JSON.stringify(want)}`);
    }
  }
}

async function runSequence(ops, profile) {
  const world = await createWorld({ sites: profile.sites ? 2 : 1 });
  const ctx = {
    active: 0, home: new Map(), switches: 0, switchesSeen: 0,
    baselines: new Map(), texts: new Map(), removed: [], counters: {}, historySeq: 0, lastMarked: [], untracked: [],
    lastUserOp: null, seen: new Set(), notified: new Set(), announcedSeen: 0,
  };
  try {
    await seed(world, ctx);
    for (const o of ops) {
      await step(world, ctx, o);
      await world.drain();
      checkShape(world);
      checkAnnounced(world, ctx);
      checkSites(world, ctx);
    }
    world.net.faults.length = 0;
    world.net.hooks.length = 0;
    if (ctx.active !== 0) switchSite(world, ctx, { to: 0 });
    world.clock.t += 1000;
    const res = await world.tracker.check();
    await world.drain();
    if (!res.ok) fail('final-check-failed', `a check without network faults failed: ${res.error}`);
    checkShape(world);
    checkAnnounced(world, ctx);
    checkSites(world, ctx);
    if (!profile.sites) checkComplete(world, ctx); // after a site switch, what an issue missed while you were away is a product question
  } finally {
    await world.stop();
  }
}

/** Shrinking may cut numbers and texts, but every op must stay one the generator could have made. */
const ENUMS = {
  op: ['jiraComment', 'jiraChange', 'jiraEdit', 'jiraAdd', 'jiraRemove', 'jiraRestore', 'jiraMove', 'switchSite', 'track', 'check', 'mark', 'unmark', 'untrack', 'restore', 'ignoreOwn', 'fault', 'midCheck', 'concurrent'],
  field: FIELDS, form: ['key', 'url', 'lower'], kind: [...Object.keys(FAULTS), 'text', 'same', 'mention'], project: ['WEB', 'OPS', 'APP'],
  endpoint: ['bulkfetch', 'changelog', 'comment', 'myself', 'search'], mention: [null, 'me', 'sam'],
};
const validOp = o => !!o && Object.entries(ENUMS).every(([k, list]) => !(k in o) || list.includes(o[k]))
  && (o.op !== 'midCheck' || (validOp(o.then) && (o.then.op.startsWith('jira') || o.then.op === 'switchSite')))
  && (o.op !== 'switchSite' || o.to === 0 || o.to === 1)
  && (o.op !== 'concurrent' || (Array.isArray(o.ops) && o.ops.length && o.ops.every(validOp) && o.ops.every(x => x.op !== 'concurrent' && x.op !== 'fault' && x.op !== 'midCheck')));

const property = (name, description, profile, runs) => ({
  name, description, runs, shrinkTries: 250,
  valid: ops => Array.isArray(ops) && ops.every(validOp),
  gen: r => genOps(r, profile),
  check: ops => runSequence(ops, profile),
  show: ops => ops.map(o => JSON.stringify(o)).join('\n'),
});

const properties = [
  property('tracker.serial', 'Jira activity and user actions one at a time: no duplicates, nothing lost, every pending change notified, restarts change nothing.', { length: 60 }, 300),
  property('tracker.faults', 'Same, with transient failures (5xx, 429, network, a 200 that is no answer) and Jira changing during a check.', { length: 60, faults: true }, 400),
  property('tracker.concurrent', 'Same, with user actions and Jira activity overlapping a running check.', { length: 40, concurrent: true }, 300),
  property('tracker.sites', 'Switching between two Jira sites, also during a check: a tracked issue stays itself, each site keeps its own list and the identity follows the site.', { length: 30, sites: true, concurrent: true }, 200),
];

module.exports = { properties };
