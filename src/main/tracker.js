'use strict';
/* Our own tracking system: which issues we follow, what changed since they were last processed,
   periodic checks and composing notifications. No Electron dependencies, so it can be tested on its own. */

const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { parseKeys } = require('../shared/keys');
const { pending, isChanged, changedList } = require('../shared/inbox');
const { changesFromChangelog, changesFromComments, commentIdOf, changesFromSnapshots, staleJql, excludedProject } = require('./changes');
const { describe, assignedToMe, changeKind, compareChanges, rankChanges } = require('../shared/change');
const { INTERVALS, THEMES, noteText, projectKey, notesProjectOf, isConfigured } = require('../shared/rules');
const { normalizeBaseUrl } = require('./jira');
const { LANGUAGE_SETTINGS, resolveLanguage, createTranslator } = require('../shared/i18n');
const { isNewer } = require('./updates');

const MIN = 60_000;
const HOUR = 60 * MIN;
const HISTORY_LIMIT = 60; // processed changes we keep per issue
const PARALLEL = 4;
const MARKED_MAX = 10_000; // change ids that Undo of Processed can still reach
const CACHE_MAX = 200; // items per cache (activity, issue types)
/** Retry delays after consecutive transient errors; never longer than the configured interval. */
const BACKOFF = [30_000, MIN, 2 * MIN, 5 * MIN];
/** No connection (including a request timeout, which jira.js reports as 'network'), a server error, or an error with neither status nor code (not from the Jira client, e.g. an unreadable response): such an error will probably go away soon. */
const isTransient = err => err.code === 'network' || err.status >= 500 || (err.status == null && !err.code);

const NO_STALE = { issues: [], fetchedAt: null, error: null };
const DEFAULT_SETTINGS = {
  baseUrl: '',
  email: '',
  defaultProject: '',
  notesProject: '', // project where "Create issue" puts a note; empty = the default project
  interval: 10,
  staleDays: 14,
  staleSort: 'oldest', // newest | oldest, by last updated
  stalePeople: [], // [{ accountId, name }] whose stale issues we show; empty = only yourself
  staleUnassigned: false, // also issues without an assignee; "Unassigned" is then a group in the filter on the Stale page
  staleFilter: [], // [accountId, or 'unassigned'] the filter on the Stale page, kept across restarts; empty = everyone
  excluded: [], // statuses that are never stale (issues in a status category Done never are)
  excludedProjects: [], // each pattern applies to both name and key, * is a wildcard
  notify: true,
  ignoreOwn: true,
  openAtLogin: false,
  theme: 'system', // system | light | dark
  language: 'system', // system (follow the OS) or one of LANGUAGES in shared/i18n.js
  checkUpdates: true, // ask GitHub once a day whether a newer IssueMon exists (see updates.js)
};
const STALE_SORTS = ['newest', 'oldest'];

/** Fills in missing fields (new install or older storage) and migrates older storage to version 5. */
function ensureShape(data) {
  const d = data && typeof data === 'object' ? data : {};
  const from = Number.isInteger(d.version) ? d.version : 0;
  d.version = 5;
  const stored = { ...(d.settings || {}) };
  // Version 1 → 2 (detected by the old fields, not by the version number): the Backlog flag became a regular status and the project fields for name and key became one.
  if ('excludeBacklog' in stored) {
    const list = Array.isArray(stored.excluded) ? stored.excluded : DEFAULT_SETTINGS.excluded.filter(s => s !== 'Backlog');
    stored.excluded = stored.excludeBacklog && !list.some(s => String(s).trim().toLowerCase() === 'backlog') ? [...list, 'Backlog'] : list;
    delete stored.excludeBacklog;
  }
  if ('excludedProjectNames' in stored || 'excludedProjectKeys' in stored) {
    if (!('excludedProjects' in stored)) stored.excludedProjects = [...new Set([...commaList(stored.excludedProjectNames), ...commaList(stored.excludedProjectKeys)])];
    delete stored.excludedProjectNames;
    delete stored.excludedProjectKeys;
  }
  // Version 2 → 3: the Stale list defaults to oldest first. Older storage also saved the old default 'newest', so it is switched once.
  if (from < 3) stored.staleSort = 'oldest';
  d.settings = { ...DEFAULT_SETTINGS, ...stored };
  // Storage from before a URL was refused: unconfigured, rather than an error on every request. The token goes with it,
  // because with no URL left nothing would stop it from being sent to the next address that is entered.
  const baseUrl = normalizeBaseUrl(d.settings.baseUrl);
  if (baseUrl !== d.settings.baseUrl) {
    if (!baseUrl) delete d.secrets;
    d.settings.baseUrl = baseUrl;
  }
  d.settings.staleFilter = idList(d.settings.staleFilter); // the renderer relies on an array
  if (!LANGUAGE_SETTINGS.includes(d.settings.language)) d.settings.language = 'system';
  d.me = d.me || null;
  // Version 4 → 5: a tracked list per site (host). `tracked` is the list of the site in `site`, the rest are kept in `sites`.
  // The list in `tracked` belongs to the host that is configured now: the stored `site` is not trusted, so a file that was edited
  // or written by another version cannot make a later save swap the list without a change of credentials.
  d.site = hostOf(d.settings.baseUrl);
  d.tracked = shapeTracked(d.tracked, d.me, from, d.lastCheck);
  const seen = new Set();
  d.sites = (Array.isArray(d.sites) ? d.sites : [])
    .filter(s => s && typeof s.host === 'string' && !seen.has(s.host) && seen.add(s.host))
    .map(s => ({ host: s.host, tracked: shapeTracked(s.tracked, null, from, d.lastCheck) })) // not the connected account's: no mention flags
    .filter(s => s.tracked.length);
  d.reconnected = d.reconnected === true;
  d.stale = { ...NO_STALE, ...(d.stale || {}) };
  // The site the list was fetched from. Storage from before has none: that list is from the configured host. A list of another site is not kept.
  if (typeof d.stale.site !== 'string') d.stale.site = d.site;
  if (d.stale.site !== d.site) d.stale = { ...NO_STALE, site: d.site };
  d.notes = Array.isArray(d.notes) ? d.notes.filter(n => n && n.id && n.text) : [];
  for (const n of d.notes) delete n.creating;
  d.lastCheck = d.lastCheck || null;
  d.updates = { lastCheck: null, latest: null, url: null, dismissed: null, ...(d.updates && typeof d.updates === 'object' ? d.updates : {}) };
  return d;
}

/** A stored tracked list: only real entries, each with a changes array, mention flags for the known account, and the 0.1.2 migration. */
function shapeTracked(list, me, from, lastCheck) {
  const tracked = Array.isArray(list) ? list.filter(t => t && t.key && !t.loading) : [];
  for (const t of tracked) {
    t.changes = Array.isArray(t.changes) ? t.changes : [];
    for (const c of t.changes) updateMentionFlag(c, me?.accountId);
    // Version 3 → 4: up to 0.1.2 an issue that was missing had an error and nothing else (checkTracked is the only place that sets one): it is not announced after the update.
    if (from < 4 && t.error && !t.missingSince) t.missingSince = lastCheck || Date.now();
  }
  return tracked;
}

/** Mention flags follow the connected account; legacy records without mention ids cannot address it. */
function updateMentionFlag(change, accountId) {
  if (change.field === 'comment' && accountId && change.mentions?.some(m => m.accountId === accountId)) change.mentionsMe = true;
  else delete change.mentionsMe;
}

async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

/** Comma-separated text or an array → list without empty values. */
const commaList = value => (Array.isArray(value) ? value : String(value || '').split(',')).map(x => String(x).trim()).filter(Boolean);
/** [{ accountId, name }] without empty ids or duplicates; a missing name becomes `unknown`. */
function peopleList(value, unknown) {
  const seen = new Set();
  return (Array.isArray(value) ? value : [])
    .map(p => ({ accountId: String(p?.accountId || '').trim(), name: String(p?.name || '').trim() || unknown }))
    .filter(p => p.accountId && !seen.has(p.accountId) && seen.add(p.accountId));
}
/** List of accountIds without empty values or duplicates. */
const idList = value => [...new Set((Array.isArray(value) ? value : []).map(id => String(id ?? '').trim()).filter(Boolean))];
const NO_PEOPLE = { list: [], fetchedAt: null, loading: false, error: null };

/** The host (with port) of a normalised base URL; '' for none. */
const hostOf = baseUrl => {
  try { return baseUrl ? new URL(baseUrl).host : ''; } catch { return String(baseUrl); }
};

class Tracker extends EventEmitter {
  /**
   * @param {object} o
   * @param {{ data: object, save(): void }} o.store
   * @param {() => object|null} o.getClient  returns a Jira client, or null if the account or token is missing
   * @param {() => boolean} o.hasToken
   * @param {(token: string) => void} o.setToken  stores the API token; an empty string deletes it
   * @param {(n: { title: string, subtitle?: string, body: string, key: string|null }) => void} o.notify
   * @param {{ platform?: string, packaged?: boolean, locale?: string }} [o.env] fixed info, also for the renderer; locale is the OS locale
   * @param {string} [o.version] the running version, for the About section
   * @param {{ check(o: { manual: boolean }): Promise<object>, dismiss(): void }} [o.updateChecker] see updates.js
   */
  constructor({ store, getClient, hasToken, setToken = () => {}, notify, env = {}, version = '', updateChecker = null, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    super();
    this.store = store;
    store.data = ensureShape(store.data);
    this.getClient = getClient;
    this.hasToken = hasToken;
    this.setToken = setToken;
    this.notify = notify;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.nextCheck = null;
    this.running = null;
    this.rewordAfterRun = false; // the language changed during a check: check again soon after it
    this.failures = 0; // consecutive transient errors, for the backoff
    this.status = { state: 'idle', message: null };
    this.removed = new Map();
    this.marked = new Set(); // change ids of the last Processed actions, for Undo; they belong to the list of the current site
    this.removedNotes = new Map();
    this.typeCache = new Map(); // project -> { at, types }, not persisted
    this.activityCache = new Map(); // key -> { at, result } (failed attempts too), not persisted
    this.staleGen = 0; // counter of refreshStale requests, to discard outdated responses
    this.credentialsGen = 0; // counter of credential changes: a check that began before one asked the old site
    this.listGen = 0; // counter of switches to another site's tracked list: a request that began before one belongs to the old site
    this.people = NO_PEOPLE; // people list for the Stale setting, not persisted
    this.env = env; // fixed info for the renderer, e.g. { platform, packaged, locale }
    this.version = version;
    this.updateChecker = updateChecker;
    this.notifications = null; // last outcome of a system notification: { ok, error, at }
    this.t = this.translator(); // every user-facing text of the tracker goes through this
  }

  /** Translator for settings.language, with 'system' following the OS locale. */
  translator() {
    return createTranslator(resolveLanguage(this.settings.language, this.env.locale), this.env.locale);
  }

  get data() { return this.store.data; }
  get settings() { return this.data.settings; }

  /** Update identity and stored flags together, without changing own-change processing decisions. */
  setMe(me) {
    this.data.me = me;
    for (const entry of this.data.tracked) {
      for (const change of entry.changes) updateMentionFlag(change, me?.accountId);
    }
  }

  configured() {
    return isConfigured(this.settings, this.hasToken());
  }

  find(key) {
    return this.data.tracked.find(t => t.key === key);
  }

  changed() {
    this.emit('change');
  }

  setStatus(state, message = null) {
    this.status = { state, message };
    this.changed();
  }

  /* ---------- scheduling ---------- */

  start() {
    if (this.configured()) this.schedule(2_000);
    else this.setStatus('unconfigured', this.t('status.unconfigured'));
  }

  stop() {
    this.clearTimer(this.timer);
    this.timer = null;
    this.nextCheck = null;
  }

  schedule(ms) {
    this.clearTimer(this.timer);
    this.timer = null;
    if (ms == null || !this.configured()) {
      this.nextCheck = null;
    } else {
      this.nextCheck = this.now() + ms;
      this.timer = this.setTimer(() => { this.check().catch(() => {}); }, ms);
    }
    this.changed();
  }

  /** After a language change: check again soon so stored texts follow, but never before a pending backoff or Retry-After. */
  recheckSoon() {
    this.schedule(this.status.state === 'error' ? Math.max(1_000, (this.nextCheck ?? 0) - this.now()) : 1_000);
  }

  /* ---------- checking ---------- */

  /** Fetches all tracked issues, detects changes, refreshes the stale list and announces new changes. */
  check() {
    if (this.running) return this.running;
    const client = this.getClient();
    if (!client) {
      this.setStatus('unconfigured', this.t('status.connectFirst'));
      this.schedule(null);
      return Promise.resolve({ ok: false, found: 0 });
    }
    this.running = (async () => {
      this.clearTimer(this.timer);
      this.setStatus('checking');
      let fresh = [];
      let delay = this.settings.interval * MIN;
      let result;
      const gen = this.credentialsGen; // old credentials must not consume or announce new account state
      try {
        if (!this.data.me) {
          const me = await client.myself();
          if (gen !== this.credentialsGen) return { ok: true, found: 0 };
          this.setMe(me);
        }
        fresh = await this.checkTracked(client, { quiet: this.data.reconnected, gen });
        if (gen !== this.credentialsGen) return { ok: true, found: 0 };
        this.data.reconnected = false; // only the first check that got an answer after (re)connecting is quiet
        await this.refreshStale(client);
        if (gen !== this.credentialsGen) return { ok: true, found: 0 };
        this.data.lastCheck = this.now();
        this.status = { state: 'ok', message: null };
        this.failures = 0;
        result = { ok: true, found: fresh.reduce((n, f) => n + f.changes.length, 0) };
      } catch (err) {
        if (gen !== this.credentialsGen) return { ok: true, found: 0 };
        this.status = { state: 'error', message: err.message, code: err.code || null };
        if (isTransient(err)) delay = Math.min(delay, BACKOFF[Math.min(this.failures++, BACKOFF.length - 1)]);
        else this.failures = 0;
        if (err.retryAfter) delay = Math.max(delay, err.retryAfter * 1000);
        result = { ok: false, found: 0, error: err.message };
      } finally {
        this.running = null;
        if (gen === this.credentialsGen) {
          this.store.save();
          this.schedule(delay);
        } else if (this.configured() && (this.nextCheck == null || this.nextCheck <= this.now())) {
          // The reconnect timer may have fired while this older check was still running.
          this.schedule(1_000);
        }
        if (this.rewordAfterRun) {
          this.rewordAfterRun = false;
          this.recheckSoon();
        }
      }
      if (fresh.length) this.announce(fresh);
      return result;
    })();
    return this.running;
  }

  /** `quiet`: issues missing from the answer are remembered (and shown in red) but not announced, such as on a new site. */
  async checkTracked(client, { quiet = false, gen = this.credentialsGen } = {}) {
    const entries = this.data.tracked.filter(t => !t.loading);
    if (!entries.length) return [];
    const { issues, errors } = await client.bulkFetch(entries.map(t => t.id || t.key));
    if (gen !== this.credentialsGen) return [];
    const byId = new Map(issues.map(i => [i.id, i]));
    const byKey = new Map(issues.map(i => [i.key, i]));
    const failed = new Set(errors.map(e => String(e?.id))); // issueErrors: Jira could not return these right now (a retriable error)
    const fresh = [];
    const now = this.now();
    const gone = []; // first-time missing issues: recorded only after identity verification

    await mapLimit(entries, PARALLEL, async t => {
      if (gen !== this.credentialsGen) return;
      const next = (t.id && byId.get(t.id)) || byKey.get(t.key);
      if (!next) {
        // Jira's rule (BulkIssueResults.issueErrors): an issue that doesn't exist or that you may not see is simply left out of the answer,
        // while issueErrors only names issues it could not return for a retriable reason. So an issue in neither list is deleted or out of reach
        // (moves are followed by id, and Jira words both the same), and one in issueErrors says nothing: its state stays as it was.
        if (failed.has(String(t.id || t.key))) return;
        if (t.missingSince) t.error = this.t('error.trackedMissing');
        else gone.push(t);
        return;
      }
      if (t.missingSince) { // back again: the error goes silently, and an open "no longer accessible" no longer holds
        delete t.missingSince;
        for (const c of t.changes) if (c.field === 'gone' && !c.processed) Object.assign(c, { processed: true, processedAt: now });
      }
      t.error = null;
      t.lastChecked = now;
      t.id = next.id;
      t.key = next.key; // the issue may have moved to another project
      const prev = t.issue;
      const since = t.seenUntil ?? prev?.updated ?? null;
      if (!prev || since == null) { // first time: only a baseline
        t.issue = next;
        t.seenUntil = next.updated;
        return;
      }
      if (!next.updated || next.updated <= since) {
        t.issue = next;
        return;
      }

      let found;
      try {
        const [histories, comments] = await Promise.all([client.changelog(t.key), client.comments(t.key)]);
        found = [...changesFromChangelog(histories, since), ...changesFromComments(comments, since, this.commentTexts(t))];
      } catch (err) {
        if (err.code === 'auth' || err.code === 'network' || err.code === 'rate_limited') throw err;
        found = changesFromSnapshots(prev, next);
      }

      if (gen !== this.credentialsGen) return;
      const known = new Set(t.changes.map(c => c.id));
      const meId = this.data.me?.accountId;
      const added = [];
      for (const c of found.sort((a, b) => a.at - b.at)) {
        if (known.has(c.id)) continue;
        const own = !!(this.settings.ignoreOwn && meId && c.author?.accountId === meId);
        const rec = { ...c, processed: own, processedAt: own ? now : null, ...(own && { own: true }) };
        updateMentionFlag(rec, meId);
        t.changes.push(rec);
        added.push(rec);
      }
      t.issue = next;
      t.seenUntil = Math.max(next.updated, since);
      if (added.length) this.activityCache.delete(t.key); // "Last activity" is now outdated
      this.prune(t);
      const news = added.filter(c => !c.processed);
      if (news.length) fresh.push({ key: t.key, summary: next.summary, changes: news });
    }).catch(err => {
      // Keep the red row across a failed check/restart, without recording a missing change yet.
      if (gen === this.credentialsGen) for (const t of gone) t.error = this.t('error.trackedMissing');
      throw err;
    });

    if (gone.length && gen === this.credentialsGen) { // after a change of credentials during this check, what the old site misses says nothing
      // Bad credentials can look like an answer too (Jira Cloud treats them as anonymous: 200, every issue left out): only report
      // when /myself still names the account we know. A failing /myself fails the check, so a dead token shows as an auth error.
      const me = await client.myself();
      if (gen !== this.credentialsGen) return [];
      const same = !this.data.me?.accountId || me.accountId === this.data.me.accountId;
      this.setMe(me);
      for (const t of gone) t.error = this.t('error.trackedMissing');
      if (same) {
        for (const t of gone) {
          t.missingSince = now;
          if (quiet) continue;
          const change = { id: `gone-${t.id || t.key}-${now}`, at: now, author: null, field: 'gone', label: null, from: null, to: null, processed: false, processedAt: null };
          t.changes.push(change);
          this.prune(t);
          fresh.push({ key: t.key, summary: t.issue?.summary || '', changes: [change] });
        }
      }
    }
    return gen === this.credentialsGen ? fresh : [];
  }

  /** Comment id → the latest text and mention ranges IssueMon recorded for it (as a new comment or an edit): the old text of the next edit. */
  commentTexts(t) {
    const texts = new Map();
    for (const c of [...t.changes].sort((a, b) => a.at - b.at)) {
      const id = commentIdOf(c);
      if (id) texts.set(id, { text: c.to ?? '', mentions: c.mentions || [] });
    }
    return texts;
  }

  async refreshStale(client) {
    const gen = ++this.staleGen; // only the newest request may write the list; a slower older one is discarded
    const skip = [];
    try {
      for (;;) {
        try {
          const people = this.settings.stalePeople.map(p => p.accountId);
          const { issues, truncated } = await client.search(staleJql({ ...this.settings, people, skip }));
          const warning = skip.length ? this.t('stale.unknownStatus', { n: skip.length, statuses: skip.join(', ') }) : null;
          if (gen !== this.staleGen) return;
          const skipProject = excludedProject(this.settings);
          this.data.stale = { issues: issues.filter(i => !skipProject(i)), truncated, fetchedAt: this.now(), error: null, warning, site: this.data.site };
          return;
        } catch (err) {
          // "The value 'Backlog' does not exist for the field 'status'." → drop that status and try again.
          const unknown = err.status === 400 ? [...err.message.matchAll(/value '([^']+)' does not exist for the field 'status'/gi)].map(m => m[1]) : [];
          if (!unknown.length || unknown.every(u => skip.includes(u))) throw err;
          skip.push(...unknown.filter(u => !skip.includes(u)));
        }
      }
    } catch (err) {
      if (err.code === 'auth' || err.code === 'network') throw err;
      if (gen === this.staleGen) {
        const kept = this.data.stale.site === this.data.site ? this.data.stale : NO_STALE; // never keep what came from another site
        this.data.stale = { ...kept, error: err.message, site: this.data.site };
      }
    }
  }

  prune(t) {
    const done = t.changes.filter(c => c.processed);
    if (done.length <= HISTORY_LIMIT) return;
    const drop = new Set(done.sort((a, b) => a.at - b.at).slice(0, done.length - HISTORY_LIMIT).map(c => c.id));
    t.changes = t.changes.filter(c => !drop.has(c.id));
  }

  /** Notifications: one per issue; with more than 3 issues at once, a single summary. */
  announce(fresh) {
    if (!this.settings.notify) return;
    const me = this.data.me?.name;
    // `fresh` contains only unprocessed changes added by this check, never older pending changes.
    const ranked = fresh.map(f => ({ ...f, lead: rankChanges(f.changes, me)[0] }));
    if (fresh.length > 3) {
      const parts = [this.t('notify.summary', { n: fresh.length })];
      const counts = {
        assignment: fresh.filter(f => f.changes.some(c => assignedToMe(c, me))).length,
        mention: fresh.filter(f => f.changes.some(c => c.mentionsMe)).length,
        risk: fresh.filter(f => f.changes.some(c => c.risk)).length,
      };
      for (const kind of ['assignment', 'mention', 'risk']) {
        if (counts[kind]) parts.push(this.t(`notify.summary.${kind}`, { n: counts[kind] }));
      }
      ranked.sort((a, b) => compareChanges(a.lead, b.lead, me) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      this.notify({ title: parts.join(' · '), body: ranked.map(f => f.key).join(', '), key: null });
      return;
    }
    for (const f of ranked) {
      const kind = changeKind(f.lead, me);
      const titleKey = kind === 'assignment' ? 'notify.assignedToYou' : kind === 'mention' ? 'notify.mentionsYou' : 'notify.changes';
      this.notify({
        title: this.t(titleKey, { key: f.key, n: f.changes.length }),
        subtitle: f.summary,
        body: describe(f.lead, { me, key: f.key, t: this.t }),
        key: f.key,
      });
    }
  }

  /* ---------- tracking ---------- */

  async addIssues(text) {
    const keys = parseKeys(text, this.settings.defaultProject);
    if (!keys.length) return { ok: false, error: this.t('error.noKey', { example: 'ABC-123' }) };
    const client = this.getClient();
    if (!client) return { ok: false, error: this.t('error.connectFirst') };

    const duplicates = keys.filter(k => this.find(k));
    const wanted = keys.filter(k => !this.find(k));
    if (!wanted.length) return { ok: true, added: [], duplicates, notFound: [] };

    const now = this.now();
    const listGen = this.listGen; // a switch to another site's list drops the placeholders: the answer is for the site we left
    const placeholders = wanted.map(key => ({ key, addedAt: now, loading: true, changes: [] }));
    this.data.tracked.unshift(...placeholders);
    this.changed();

    const drop = p => { this.data.tracked = this.data.tracked.filter(t => t !== p); };
    let issues;
    try {
      ({ issues } = await client.bulkFetch(wanted));
    } catch (err) {
      if (listGen !== this.listGen) return { ok: false, error: this.t('error.siteChanged') };
      placeholders.forEach(drop);
      this.changed();
      return { ok: false, error: err.message };
    }
    if (listGen !== this.listGen) return { ok: false, error: this.t('error.siteChanged') };

    const byKey = new Map(issues.map(i => [i.key, i]));
    const added = [];
    const notFound = [];
    for (const p of placeholders) {
      const issue = byKey.get(p.key);
      if (!issue) {
        notFound.push(p.key);
        drop(p);
      } else if (this.data.tracked.some(t => t !== p && t.id === issue.id)) {
        duplicates.push(p.key);
        drop(p);
      } else {
        Object.assign(p, { id: issue.id, issue, seenUntil: issue.updated, lastChecked: now, error: null });
        delete p.loading;
        added.push(p.key);
      }
    }
    this.store.save();
    this.changed();
    if (!this.timer && !this.running && this.configured()) this.schedule(this.settings.interval * MIN);
    return { ok: true, added, duplicates, notFound };
  }

  /** Tracks an issue from the stale list (we already have its data); any other key goes through addIssues. */
  async track(key) {
    if (this.find(key)) return { ok: true, added: [], duplicates: [key], notFound: [] };
    const issue = this.data.stale.issues.find(i => i.key === key);
    if (!issue) return this.addIssues(key);
    if (this.data.stale.site !== this.data.site) return { ok: false, error: this.t('error.siteChanged') }; // a list of the previous site holds other issues
    this.data.tracked.unshift({ key, id: issue.id, issue, seenUntil: issue.updated, addedAt: this.now(), lastChecked: this.now(), changes: [] });
    this.store.save();
    this.changed();
    return { ok: true, added: [key], duplicates: [], notFound: [] };
  }

  untrack(key) {
    const index = this.data.tracked.findIndex(t => t.key === key);
    if (index < 0) return false;
    const [entry] = this.data.tracked.splice(index, 1);
    this.removed.set(key, { entry, index });
    this.store.save();
    this.changed();
    return true;
  }

  /** Undoes untrack. */
  restore(key) {
    const r = this.removed.get(key);
    if (!r || this.find(key)) return false;
    for (const change of r.entry.changes) updateMentionFlag(change, this.data.me?.accountId);
    this.data.tracked.splice(Math.min(r.index, this.data.tracked.length), 0, r.entry);
    this.removed.delete(key);
    this.store.save();
    this.changed();
    return true;
  }

  /** Marks all pending changes of these issues as processed. Returns the change ids (for undo). */
  markProcessed(keys) {
    const ids = [];
    const now = this.now();
    for (const key of [].concat(keys)) {
      const t = this.find(key);
      if (!t) continue;
      for (const c of pending(t)) {
        c.processed = true;
        c.processedAt = now;
        ids.push(c.id);
        this.marked.add(c.id);
      }
    }
    while (this.marked.size > MARKED_MAX) this.marked.delete(this.marked.values().next().value);
    if (ids.length) { this.store.save(); this.changed(); }
    return ids;
  }

  unmark(ids) {
    const set = new Set([].concat(ids).filter(id => this.marked.delete(id)));
    for (const t of this.data.tracked) for (const c of t.changes) if (set.has(c.id)) { c.processed = false; c.processedAt = null; }
    this.store.save();
    this.changed();
    return true;
  }

  /* ---------- notes ---------- */

  findNote(id) {
    return this.data.notes.find(n => n.id === id);
  }

  addNote(text) {
    const value = noteText(text);
    if (!value) return null;
    const note = { id: randomUUID(), text: value, createdAt: this.now() };
    this.data.notes.unshift(note);
    this.store.save();
    this.changed();
    return note;
  }

  /** Empty text is rejected: deleting goes through removeNote. */
  editNote(id, text) {
    const note = this.findNote(id);
    const value = noteText(text);
    if (!note || note.creating || !value) return false;
    if (value !== note.text) {
      note.text = value;
      note.updatedAt = this.now();
      this.store.save();
      this.changed();
    }
    return true;
  }

  /** Checks a note off (struck through) or back on. */
  setNoteDone(id, done) {
    const note = this.findNote(id);
    if (!note || note.creating) return false;
    if (!!note.done !== !!done) {
      if (done) Object.assign(note, { done: true, doneAt: this.now() });
      else { delete note.done; delete note.doneAt; }
      this.store.save();
      this.changed();
    }
    return true;
  }

  /** Moves a note to position `index` in the list (0 = top); an index outside the list becomes the nearest end. */
  moveNote(id, index) {
    const notes = this.data.notes;
    const from = notes.findIndex(n => n.id === id);
    if (from < 0) return false;
    const to = Math.max(0, Math.min(notes.length - 1, Math.trunc(index) || 0));
    if (to !== from) {
      notes.splice(to, 0, ...notes.splice(from, 1));
      this.store.save();
      this.changed();
    }
    return true;
  }

  removeNote(id) {
    const index = this.data.notes.findIndex(n => n.id === id);
    if (index < 0 || this.data.notes[index].creating) return false;
    const [note] = this.data.notes.splice(index, 1);
    this.removedNotes.set(id, { note, index });
    this.store.save();
    this.changed();
    return true;
  }

  /** Undoes removeNote. */
  restoreNote(id) {
    const r = this.removedNotes.get(id);
    if (!r || this.findNote(id)) return false;
    this.data.notes.splice(Math.min(r.index, this.data.notes.length), 0, r.note);
    this.removedNotes.delete(id);
    this.store.save();
    this.changed();
    return true;
  }

  /** Puts a value in a cache of at most CACHE_MAX items: the least recently stored one goes. */
  remember(cache, key, value) {
    cache.delete(key);
    cache.set(key, value);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  /** Plain issue types of a project, remembered for an hour. Returns { ok, types } or { ok: false, error }. */
  async issueTypes(project) {
    const key = projectKey(project) || notesProjectOf(this.settings);
    if (!key) return { ok: false, error: this.t('error.projectRequired') };
    const client = this.getClient();
    if (!client) return { ok: false, error: this.t('error.connectFirst') };
    const cached = this.typeCache.get(key);
    if (cached && this.now() - cached.at < HOUR) return { ok: true, types: cached.types };
    const listGen = this.listGen;
    try {
      const types = await client.issueTypes(key);
      if (listGen !== this.listGen) return { ok: false, error: this.t('error.siteChanged') };
      this.remember(this.typeCache, key, { at: this.now(), types });
      return { ok: true, types };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * Last comment and last field change of an issue. A successful response is kept for ten minutes,
   * a failed attempt for thirty seconds; new changes found by a check, or a different account, clear
   * either. Freshness is handled here: the renderer may ask often and compares `fetchedAt`.
   * Returns { ok, comment, change, fetchedAt } or { ok: false, error, fetchedAt }.
   */
  async activity(key) {
    key = String(key || '').toUpperCase();
    const client = this.getClient();
    if (!client) return { ok: false, error: this.t('error.connectFirst') };
    const cached = this.activityCache.get(key);
    if (cached && this.now() - cached.at < (cached.result.ok ? 10 * MIN : 30e3)) return cached.result;
    const listGen = this.listGen;
    try {
      const [comments, histories] = await Promise.all([client.comments(key), client.changelog(key)]);
      if (listGen !== this.listGen) return { ok: false, error: this.t('error.siteChanged'), fetchedAt: this.now() };
      const newest = list => list.reduce((a, b) => (!a || b.at >= a.at ? b : a), null);
      const comment = newest(changesFromComments(comments, null));
      const change = newest(changesFromChangelog(histories, null));
      const result = {
        ok: true,
        comment: comment && { author: comment.author, at: comment.at, text: comment.to },
        change: change && { author: change.author, at: change.at, field: change.field, label: change.label, from: change.from, to: change.to },
        fetchedAt: this.now(),
      };
      this.remember(this.activityCache, key, { at: this.now(), result });
      return result;
    } catch (err) {
      const result = { ok: false, error: err.message, fetchedAt: this.now() };
      if (listGen !== this.listGen) return { ...result, error: this.t('error.siteChanged') };
      this.remember(this.activityCache, key, { at: this.now(), result });
      return result;
    }
  }

  /**
   * Turns a note into an issue in the backlog and tracks that issue. The note disappears.
   * `summary`, `project` and `typeId` override the note text, the notes project and the default type.
   */
  async createIssueFromNote(id, { summary, project, typeId } = {}) {
    const note = this.findNote(id);
    if (!note) return { ok: false, error: this.t('error.noteGone') };
    if (note.creating) return { ok: false, error: this.t('error.issueCreating') };
    const title = noteText(summary ?? note.text);
    if (!title) return { ok: false, error: this.t('error.titleRequired') };
    const key = projectKey(project) || notesProjectOf(this.settings);
    if (!key) return { ok: false, error: this.t('error.notesProjectRequired') };
    const client = this.getClient();
    if (!client) return { ok: false, error: this.t('error.connectFirst') };

    const listGen = this.listGen;
    note.creating = true;
    this.changed();
    let created;
    try {
      created = await client.createIssue({ project: key, summary: title, typeId: typeId ? String(typeId) : undefined });
    } catch (err) {
      return { ok: false, error: err.message };
    } finally {
      delete note.creating;
      this.changed();
    }
    // The issue exists now: remove the note, so one note never produces two issues.
    this.data.notes = this.data.notes.filter(n => n !== note);
    this.store.save();
    if (listGen !== this.listGen) return { ok: true, key: created.key, tracked: false, error: this.t('error.siteChanged') }; // the issue is on the site we left: not for the new list
    const r = await this.addIssues(created.key);
    if (r.ok && (r.added.includes(created.key) || r.duplicates.includes(created.key))) return { ok: true, key: created.key, tracked: true };
    return { ok: true, key: created.key, tracked: false, error: r.error || this.t('error.newIssueUnavailable') };
  }

  /* ---------- settings ---------- */

  saveSettings(patch = {}) {
    const s = this.settings;
    const before = { ...s };
    const next = { ...s };
    // A refused address (not an address, or plain http to a non-local host) leaves the stored URL and token alone, so a typo
    // doesn't disconnect you. Only an emptied field clears the URL.
    let urlRefused = false;
    if ('baseUrl' in patch) {
      const url = normalizeBaseUrl(patch.baseUrl);
      if (!url && String(patch.baseUrl || '').trim()) urlRefused = true;
      else next.baseUrl = url;
    }
    if ('email' in patch) next.email = String(patch.email || '').trim();
    if ('defaultProject' in patch) next.defaultProject = projectKey(patch.defaultProject);
    if ('notesProject' in patch) next.notesProject = projectKey(patch.notesProject);
    if ('interval' in patch) next.interval = INTERVALS.includes(+patch.interval) ? +patch.interval : s.interval;
    if ('staleDays' in patch) next.staleDays = Math.min(365, Math.max(1, parseInt(patch.staleDays, 10) || s.staleDays));
    if ('stalePeople' in patch) {
      const list = peopleList(patch.stalePeople, this.t('person.unknown'));
      // Only yourself is the default: leave it empty then, so it stays correct after switching accounts.
      next.stalePeople = list.length === 1 && list[0].accountId === this.data.me?.accountId ? [] : list;
    }
    if ('staleFilter' in patch) next.staleFilter = idList(patch.staleFilter); // only stored: the app filters by itself, so no refresh
    if ('excluded' in patch) next.excluded = commaList(patch.excluded);
    if ('excludedProjects' in patch) next.excludedProjects = commaList(patch.excludedProjects);
    for (const k of ['notify', 'ignoreOwn', 'openAtLogin', 'staleUnassigned', 'checkUpdates']) if (k in patch) next[k] = !!patch[k];
    if ('theme' in patch && THEMES.includes(patch.theme)) next.theme = patch.theme;
    if ('staleSort' in patch && STALE_SORTS.includes(patch.staleSort)) next.staleSort = patch.staleSort;
    if ('language' in patch && LANGUAGE_SETTINGS.includes(patch.language)) next.language = patch.language;
    this.data.settings = next;
    if (hostOf(next.baseUrl) !== this.data.site) this.switchSite(hostOf(next.baseUrl));

    // The token is only ever sent to the site it was entered for: another host (or no valid address any more) clears it,
    // unless the same patch brings a new token.
    const newToken = typeof patch.token === 'string' ? patch.token.trim() : '';
    if (newToken) this.setToken(newToken);
    else if (before.baseUrl && hostOf(next.baseUrl) !== hostOf(before.baseUrl)) this.setToken('');

    const languageChanged = next.language !== before.language;
    if (languageChanged) this.t = this.translator(); // before credentialsChanged, which words the status
    const accountChanged = next.baseUrl !== before.baseUrl || next.email !== before.email;
    if (accountChanged) this.credentialsChanged();
    else if (next.interval !== before.interval && this.nextCheck && !this.running) {
      const last = this.data.lastCheck || this.now();
      this.schedule(Math.max(5_000, last + next.interval * MIN - this.now()));
    }
    // Texts made in the old language: re-word the status, or check again soon so errors and warnings follow.
    if (languageChanged && !accountChanged) {
      if (this.people.error) this.people = NO_PEOPLE; // the next loadPeople fetches again and words the error anew
      if (this.status.state === 'unconfigured') this.status = { state: 'unconfigured', message: this.t('status.unconfigured') };
      else if (this.running) this.rewordAfterRun = true;
      else if (this.configured()) this.recheckSoon();
    }
    const ids = list => list.map(p => p.accountId).join();
    const staleChanged = next.staleDays !== before.staleDays
      || ['excluded', 'excludedProjects'].some(k => next[k].join() !== before[k].join())
      || ids(next.stalePeople) !== ids(before.stalePeople)
      || next.staleUnassigned !== before.staleUnassigned
      || (next.staleSort !== before.staleSort && this.data.stale.truncated); // otherwise the app sorts by itself; Jira is only needed to get the right first 1000
    if (!accountChanged && staleChanged) {
      const client = this.getClient();
      if (client) this.refreshStale(client).then(() => { this.store.save(); this.changed(); }, () => {});
    }
    this.store.save();
    this.changed();
    // For the outside world (main: theme, language, menu, open at login): only keys whose normalized value actually differs.
    const changed = Object.keys(next).filter(k => JSON.stringify(next[k]) !== JSON.stringify(before[k]));
    if (changed.length) this.emit('settings', { before, next, changed });
    return urlRefused ? { ...next, urlRefused: true } : next;
  }

  /**
   * Swaps in the tracked list of another site (host): `tracked` is always the list of `site`, the lists of the sites we left are in `sites`.
   * Jira ids only mean something within one site, so a list is never asked about another site. A site that was never used starts empty;
   * the list of an unconfigured state (no URL yet) goes to the first site entered, as storage from before this did.
   */
  switchSite(host) {
    const old = this.data.site;
    this.setMe(null); // the account is not known on the next site: mention flags are cleared now, so no list is kept with another account's flags
    const live = this.data.tracked.filter(t => !t.loading); // a request still adding an issue notices through listGen
    const saved = this.data.sites.find(s => s.host === host);
    const sites = this.data.sites.filter(s => s !== saved && s.host !== old);
    let next = saved ? saved.tracked : [];
    if (old === '' && !saved) next = live;
    else if (live.length) sites.push({ host: old, tracked: live });
    this.data.sites = sites;
    this.data.tracked = next;
    this.data.site = host;
    this.removed.clear(); // Undo of Stop tracking and of Processed belongs to the list it came from
    this.marked.clear();
    this.data.stale = { ...NO_STALE, site: host }; // fetched from the site we left; the next check fetches the new site's
    this.listGen++;
  }

  /** After a change of URL, email or token: log in again and check soon. */
  credentialsChanged() {
    this.setMe(null);
    this.data.reconnected = true; // the new site may not know the issues tracked on the old one: the next check that gets an answer reports none missing
    this.credentialsGen++;
    this.staleGen++; // invalidate any in-flight stale list from the previous account
    this.people = NO_PEOPLE;
    this.activityCache.clear();
    this.typeCache.clear();
    this.store.save();
    if (this.configured()) {
      this.status = { state: 'idle', message: null };
      this.schedule(1_000);
    } else {
      this.stop();
      this.setStatus('unconfigured', this.t('status.unconfigured'));
    }
  }

  async testConnection() {
    const client = this.getClient();
    if (!client) return { ok: false, message: this.t('error.accountIncomplete') };
    const gen = this.credentialsGen;
    try {
      const me = await client.myself();
      if (gen !== this.credentialsGen) return { ok: false, message: null };
      this.setMe(me);
      this.store.save();
      if (!this.running) this.schedule(500);
      this.loadPeople();
      return { ok: true, message: this.t('status.connectedAs', { name: me.name || this.t('person.unknown') }) };
    } catch (err) {
      return { ok: false, message: gen === this.credentialsGen ? err.message : null };
    }
  }

  /** Colleagues for the people list under Stale. Refetched at most once an hour (sooner after an error), unless `force`. */
  async loadPeople({ force = false } = {}) {
    const p = this.people;
    if (p.loading || (!force && !p.error && p.fetchedAt && this.now() - p.fetchedAt < HOUR)) return p;
    const client = this.getClient();
    if (!client) return p;
    const gen = this.credentialsGen;
    const loading = this.people = { ...p, loading: true, error: null };
    this.changed();
    try {
      if (!this.data.me) { // needed to point out yourself in the list
        const me = await client.myself();
        if (gen !== this.credentialsGen) return this.people;
        this.setMe(me);
        this.store.save();
      }
      const list = await client.users();
      if (gen !== this.credentialsGen) return this.people;
      if (this.people === loading) this.people = { list, fetchedAt: this.now(), loading: false, error: null };
    } catch (err) {
      if (gen !== this.credentialsGen) return this.people;
      if (this.people === loading) this.people = { ...loading, loading: false, error: err.message };
    }
    this.changed();
    return this.people;
  }

  /* ---------- to the renderer ---------- */

  publicState() {
    return {
      settings: { ...this.settings, hasToken: this.hasToken() },
      me: this.data.me,
      tracked: this.data.tracked,
      stale: this.data.stale,
      notes: this.data.notes,
      people: this.people,
      status: { ...this.status, lastCheck: this.data.lastCheck, nextCheck: this.nextCheck },
      notifications: this.notifications,
      env: this.env,
      version: this.version,
      updates: { ...this.updates, newer: isNewer(this.updates.latest, this.version) },
    };
  }

  /* ---------- updates (notify only; see updates.js) ---------- */

  get updates() { return this.data.updates; }

  /** The update checker's state: merges the patch, stores it and tells the renderer. */
  setUpdates(patch) {
    this.data.updates = { ...this.data.updates, ...patch };
    this.store.save();
    this.changed();
  }

  /** Manual check (Settings, app menu): { ok: true, latest, url, newer } or { ok: false }. */
  checkUpdates() {
    return this.updateChecker ? this.updateChecker.check({ manual: true }) : Promise.resolve({ ok: false });
  }

  /** "Later": hides the version that is available now until a newer one appears. */
  dismissUpdate() {
    this.updateChecker?.dismiss();
    return true;
  }

  setNotificationStatus(status) {
    this.notifications = status;
    this.changed();
  }

  changedCount() {
    return this.data.tracked.filter(isChanged).length;
  }

  /** Issues with pending changes as [{ key, summary, at }], newest change first (for the tray menu). */
  changedIssues() {
    return changedList(this.data.tracked)
      .map(t => ({ key: t.key, summary: t.issue?.summary || '', at: Math.max(...pending(t).map(c => c.at || 0)) }));
  }
}

module.exports = { Tracker, ensureShape, DEFAULT_SETTINGS };
