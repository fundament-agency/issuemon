'use strict';
/* Thin Jira Cloud REST v3 client. Network goes through an injected fetch (Electron net.fetch in the app, global fetch in tests). */

const { normalizeIssue, ISSUE_FIELDS } = require('./changes');
const { defaultIssueType } = require('../shared/rules');
const { createTranslator } = require('../shared/i18n');
const { truncate } = require('../shared/text');

const PAGE = 100;

class JiraError extends Error {
  constructor(message, { status = null, code = null, retryAfter = null, details = [], cause } = {}) {
    super(message, { cause });
    this.name = 'JiraError';
    this.details = details; // Jira's own messages (errorMessages and errors), apart from IssueMon's wording around them
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * "yourcompany.atlassian.net/browse/ABC-1" → "https://yourcompany.atlassian.net".
 * Plain http is refused (→ '') except for local addresses, so the Basic auth header never travels in cleartext.
 */
function normalizeBaseUrl(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol === 'http:' && !LOCAL_HOSTS.includes(u.hostname)) return '';
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

/** Messages from a Jira response: JSON (errorMessages/errors) or plain text, such as "XSRF check failed". */
async function errorDetails(res) {
  const text = await res.text().catch(() => '');
  try {
    const body = JSON.parse(text);
    return [...(body.errorMessages || []), ...Object.values(body.errors || {})].filter(m => typeof m === 'string' && m);
  } catch {
    const plain = /<html/i.test(text) ? '' : truncate(text.replace(/\s+/g, ' ').trim(), 200);
    return plain ? [plain] : [];
  }
}

async function toError(res, method, url, t) {
  const details = await errorDetails(res);
  const detail = details.join(' ');
  const params = { call: `${method} ${url.pathname}`, status: res.status, detail };
  // With Jira's own explanation the message ends in it; without one, in a full stop.
  const message = key => t(detail ? `${key}Detail` : key, params);
  const retry = Number(res.headers.get('retry-after'));
  const opts = { status: res.status, retryAfter: Number.isFinite(retry) && retry > 0 ? retry : null, details };
  switch (res.status) {
    case 401: return new JiraError(t('error.jira.auth'), { ...opts, code: 'auth' });
    case 403: return new JiraError(message('error.jira.forbidden'), { ...opts, code: 'forbidden' });
    case 404: return new JiraError(message('error.jira.notFound'), { ...opts, code: 'not_found' });
    case 429: return new JiraError(t('error.jira.rateLimited'), { ...opts, code: 'rate_limited' });
    default: return new JiraError(res.status >= 500 ? t('error.jira.server', params) : message('error.jira.rejected'), opts);
  }
}

/** Plain issue types: no subtask and no epic (or other higher level). */
const plainTypes = types => types.filter(t => !t.subtask && (t.hierarchyLevel ?? 0) === 0);

/** Type for a new issue: Task (or its name in another language, see rules.js), otherwise the first plain type. Never an epic or subtask. */
function pickIssueType(types) {
  return defaultIssueType(plainTypes(types));
}

/**
 * @param {{ baseUrl: string, email: string, token: string, userAgent?: string, fetch?: typeof fetch, timeoutMs?: number, t?: Function }} opts
 * t: translator for the error messages (shared/i18n.js), English by default.
 * userAgent: Jira Cloud rejects POST requests with a browser User-Agent ("XSRF check failed", 403),
 * and Electron's net.fetch sends Chrome's by default. So we always send our own User-Agent.
 */
function createJiraClient({ baseUrl, email, token, userAgent = 'IssueMon', fetch: fetchImpl = globalThis.fetch, timeoutMs = 20_000, t = createTranslator('en') }) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new JiraError(t('error.jira.config'), { code: 'config' });
  const auth = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;

  async function request(method, path, { query, body } = {}) {
    const url = new URL(path, base);
    for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, String(v));
    let res;
    try {
      res = await fetchImpl(url.toString(), {
        method,
        headers: {
          Authorization: auth,
          Accept: 'application/json',
          'User-Agent': userAgent,
          ...(body && { 'Content-Type': 'application/json' }),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new JiraError(t('error.jira.network', { host: url.host }), { code: 'network', cause: err });
    }
    if (!res.ok) throw await toError(res, method, url, t);
    if (res.status === 204) return null;
    try {
      return await res.json();
    } catch (err) {
      // A 200 that is no JSON (a proxy's or a portal's page) is no answer: no status and no code, so it counts as transient.
      throw new JiraError(t('error.jira.unreadable', { call: `${method} ${url.pathname}` }), { cause: err });
    }
  }

  /** The list in a paginated answer; a 200 without it is unreadable, like for bulkFetch, never an empty list. */
  function listOf(res, listProp, path) {
    if (!Array.isArray(res?.[listProp])) throw new JiraError(t('error.jira.unreadable', { call: `GET ${path}` }));
    return res[listProp];
  }

  /** Fetches the last page of an oldest-first paginated list (at most 100 items). */
  async function latestPage(path, listProp) {
    const first = await request('GET', path, { query: { startAt: 0, maxResults: PAGE } });
    const items = listOf(first, listProp, path);
    const total = first.total ?? items.length;
    if (total <= PAGE) return items;
    const last = await request('GET', path, { query: { startAt: Math.max(0, total - PAGE), maxResults: PAGE } });
    return listOf(last, listProp, path);
  }

  /** Plain issue types (see plainTypes) of a project, with a readable error if the project doesn't exist or you can't create issues in it. */
  async function plainIssueTypes(project) {
    let meta;
    try {
      meta = await request('GET', `/rest/api/3/issue/createmeta/${encodeURIComponent(project)}/issuetypes`);
    } catch (err) {
      if (err.code !== 'not_found' && err.code !== 'forbidden') throw err;
      throw new JiraError(t('error.jira.projectUnavailable', { project }), { status: err.status, code: err.code, cause: err });
    }
    // The documentation calls the list issueTypes; some sites return values.
    return plainTypes(meta.issueTypes || meta.values || []);
  }

  return {
    baseUrl: base,

    async myself() {
      const u = await request('GET', '/rest/api/3/myself');
      return { accountId: u.accountId, name: u.displayName, email: u.emailAddress || null };
    },

    /** All active people on the site, sorted by name in the translator's locale: no apps, customers or deactivated accounts. */
    async users() {
      const out = [];
      // Jira can return a page shorter than requested, so keep going until an empty page (and at most 5000).
      for (let startAt = 0; startAt < 5000; startAt += PAGE) {
        const page = await request('GET', '/rest/api/3/users/search', { query: { startAt, maxResults: PAGE } });
        if (!Array.isArray(page) || !page.length) break;
        for (const u of page) if (u.accountType === 'atlassian' && u.active) out.push({ accountId: u.accountId, name: u.displayName || t('person.unknown') });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name, t.locale));
    },

    /** Several issues at once (by id or key), including the description (search leaves it out, as it fetches up to 1000 issues). Unknown or inaccessible issues are simply missing from `issues`; `errors` (issueErrors, { id, errorMessage }) only names issues Jira could not return for a retriable reason. */
    async bulkFetch(idsOrKeys) {
      const issues = [];
      const errors = [];
      for (let i = 0; i < idsOrKeys.length; i += PAGE) {
        const res = await request('POST', '/rest/api/3/issue/bulkfetch', {
          body: { issueIdsOrKeys: idsOrKeys.slice(i, i + PAGE), fields: [...ISSUE_FIELDS, 'description'] },
        });
        // A 200 without a list of issues is no answer (a proxy's page, an empty body): with no status and no code the error counts as
        // transient, so the check is retried with backoff and nothing is concluded from what is missing.
        if (!Array.isArray(res?.issues)) throw new JiraError(t('error.jira.unreadable', { call: 'POST /rest/api/3/issue/bulkfetch' }));
        issues.push(...res.issues.map(normalizeIssue));
        errors.push(...(Array.isArray(res.issueErrors) ? res.issueErrors : []));
      }
      return { issues, errors };
    },

    /** Last ≤100 changelog histories (oldest first). */
    changelog: key => latestPage(`/rest/api/3/issue/${encodeURIComponent(key)}/changelog`, 'values'),

    /** Last ≤100 comments (oldest first). */
    comments: key => latestPage(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, 'comments'),

    /** All results (pages of 100 via nextPageToken), up to `max`. `truncated` = there were more. */
    async search(jql, { max = 1000 } = {}) {
      const issues = [];
      let nextPageToken = null;
      do {
        const res = await request('POST', '/rest/api/3/search/jql', {
          body: { jql, fields: ISSUE_FIELDS, maxResults: Math.min(PAGE, max - issues.length), ...(nextPageToken && { nextPageToken }) },
        });
        issues.push(...(res.issues || []).map(normalizeIssue));
        nextPageToken = !res.isLast && res.nextPageToken ? res.nextPageToken : null;
      } while (nextPageToken && issues.length < max);
      return { issues, truncated: !!nextPageToken };
    },

    /** Plain issue types of `project` as [{ id, name }], to choose from for a new issue. */
    issueTypes: async project => (await plainIssueTypes(project)).map(t => ({ id: String(t.id), name: t.name })),

    /**
     * New issue in `project` (key), without a sprint: it lands in the backlog. Returns { id, key }.
     * `typeId` must be a plain type of the project; otherwise (or without one) pickIssueType chooses the type.
     */
    async createIssue({ project, summary, typeId }) {
      const plain = await plainIssueTypes(project);
      const type = plain.find(t => typeId != null && String(t.id) === String(typeId)) || pickIssueType(plain);
      if (!type) throw new JiraError(t('error.jira.noIssueType', { project }), { code: 'config' });
      const res = await request('POST', '/rest/api/3/issue', {
        body: { fields: { project: { key: project }, issuetype: { id: type.id }, summary } },
      });
      return { id: String(res.id), key: res.key };
    },
  };
}

module.exports = { createJiraClient, normalizeBaseUrl, pickIssueType, JiraError };
