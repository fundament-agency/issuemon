'use strict';
/* Pure functions: Jira responses → normalized issues and changes. No Electron, no network. */
const { truncate } = require('../shared/text');

/** Jira dates such as "2026-10-09T13:02:11.123+0200" → epoch ms (or null). */
function parseJiraDate(value) {
  if (!value) return null;
  const iso = String(value).replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** A Jira user, or null when there is none (unassigned). A missing display name stays null: the UI words it in its own language. */
const user = u => (u ? { accountId: u.accountId || null, name: u.displayName || null } : null);

/** Fields we fetch per issue (bulkFetch adds the description). */
const ISSUE_FIELDS = ['summary', 'status', 'assignee', 'priority', 'issuetype', 'updated', 'labels', 'fixVersions', 'project', 'parent', 'subtasks', 'issuelinks', 'duedate'];

/** The description is kept in storage; more than this is not needed for an overview. */
const DESCRIPTION_MAX = 2000;

/** Related issues are shallow: Jira may omit fields when access is limited. */
function relatedIssue(raw) {
  if (!raw || typeof raw.key !== 'string' || !raw.key) return null;
  return {
    key: raw.key,
    summary: raw.fields?.summary || '',
    status: raw.fields?.status?.name || null,
    statusCat: raw.fields?.status?.statusCategory?.key || 'new',
  };
}

const array = value => Array.isArray(value) ? value : [];
const named = value => typeof value === 'string' && value.length > 0;

function normalizeIssue(raw) {
  const f = raw.fields || {};
  return {
    id: String(raw.id),
    key: raw.key,
    summary: f.summary || '',
    status: f.status?.name || null,
    statusCat: f.status?.statusCategory?.key || 'new', // new | indeterminate | done
    type: f.issuetype?.name || null,
    subtask: !!f.issuetype?.subtask,
    priority: f.priority?.name || null,
    assignee: user(f.assignee),
    updated: parseJiraDate(f.updated),
    labels: array(f.labels).filter(named),
    fixVersions: array(f.fixVersions).map(v => v?.name).filter(named),
    parent: relatedIssue(f.parent),
    subtasks: array(f.subtasks).map(relatedIssue).filter(Boolean),
    links: array(f.issuelinks).flatMap(link => {
      const issue = relatedIssue(link?.inwardIssue || link?.outwardIssue);
      if (!issue) return [];
      return [{ type: (link.inwardIssue ? link.type?.inward : link.type?.outward) || link.type?.name || null, issue }];
    }),
    project: f.project?.name || null,
    projectKey: f.project?.key || null,
    description: truncate(adfToText(f.description), DESCRIPTION_MAX),
    due: typeof f.duedate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f.duedate) ? f.duedate : null, // Jira's due date is a day, YYYY-MM-DD
  };
}

/* Changelog field names → our field names. Unknown fields become 'other' with the original label. */
const FIELD_MAP = {
  status: 'status',
  assignee: 'assignee',
  priority: 'priority',
  summary: 'summary',
  description: 'description',
  labels: 'labels',
  'Fix Version': 'fixVersion',
  Attachment: 'attachment',
  resolution: 'resolution',
  Sprint: 'sprint',
  duedate: 'duedate',
  issuetype: 'issuetype',
  reporter: 'reporter',
  Key: 'key',
};
/* Noise nobody wants to see: backlog order and time tracking. */
const IGNORED_FIELDS = new Set(['Rank', 'WorklogId', 'timespent', 'timeestimate', 'timeoriginalestimate', 'WorklogTimeSpent', 'Worklog Id']);

const isObject = v => v != null && typeof v === 'object';

/**
 * Changelog histories → changes, only after `since` (exclusive).
 * @returns {Array<{id,at,author,field,label,from,to}>}
 */
function changesFromChangelog(histories, since) {
  const out = [];
  for (const h of Array.isArray(histories) ? histories : []) {
    if (!isObject(h)) continue; // a malformed entry is skipped, never a reason to lose the rest
    const at = parseJiraDate(h.created);
    if (at == null || (since != null && at <= since)) continue;
    (Array.isArray(h.items) ? h.items : []).forEach((item, idx) => {
      if (!isObject(item) || IGNORED_FIELDS.has(item.field)) return;
      out.push({
        id: `h${h.id}-${idx}`,
        at,
        author: user(h.author),
        field: FIELD_MAP[item.field] || 'other',
        label: item.field,
        from: item.fromString ?? null,
        to: item.toString ?? null,
      });
    });
  }
  return out;
}

/**
 * Comments → changes, only after `since` (exclusive). A comment created after `since` is a new comment with its latest
 * text (id `c<id>`). An older comment edited after `since` is an edit by its updateAuthor (id `c<id>@<edit time>`, so
 * every edit counts once); `previous` (comment id → text, or { text, mentions } IssueMon saw before) gives its old text, else `from` is null.
 * A comment IssueMon already saw counts only as an edit, and not when its text and mention targets are unchanged (a save without changes,
 * or a new visibility).
 */
function changesFromComments(comments, since, previous = new Map()) {
  const out = [];
  for (const c of Array.isArray(comments) ? comments : []) {
    if (!isObject(c)) continue;
    const at = parseJiraDate(c.created);
    if (at == null) continue;
    const { text: to, mentions } = adfContent(c.body);
    const metadata = mentions.length ? { mentions } : {};
    const prior = previous.get(String(c.id));
    const seen = typeof prior === 'object' ? prior?.text : prior;
    const sameMentions = JSON.stringify(prior?.mentions || []) === JSON.stringify(mentions);
    if ((since == null || at > since) && seen === undefined) {
      out.push({ id: `c${c.id}`, at, author: user(c.author), field: 'comment', label: 'Comment', from: null, to, ...metadata });
      continue;
    }
    const edited = parseJiraDate(c.updated);
    if (edited == null || (since != null && edited <= since) || (seen === to && sameMentions)) continue;
    out.push({
      id: `c${c.id}@${edited}`, at: edited, author: user(c.updateAuthor || c.author), field: 'comment', label: 'Comment',
      edited: true, from: seen ?? null, to, ...metadata,
    });
  }
  return out;
}

/** The Jira comment id of a comment change (`c<id>` or `c<id>@<edit time>`), else null. */
const commentIdOf = change => (change.field === 'comment' ? /^c([^@]+)/.exec(change.id || '')?.[1] ?? null : null);

/** Same user: by account id when both have one, else by name (so a user without a name is not "unassigned"). */
const sameUser = (a, b) => (!a || !b ? !a === !b : a.accountId && b.accountId ? a.accountId === b.accountId : (a.name || null) === (b.name || null));

/**
 * Fallback when the changelog can't be fetched: compare two snapshots.
 * The author is unknown then; the id is stable per field and time.
 */
function changesFromSnapshots(prev, next) {
  if (!prev || !next) return [];
  const at = next.updated || Date.now();
  const pairs = [
    ['status', prev.status, next.status],
    ['assignee', prev.assignee?.name || null, next.assignee?.name || null, !sameUser(prev.assignee, next.assignee)],
    ['priority', prev.priority, next.priority],
    ['summary', prev.summary, next.summary],
    ['labels', prev.labels.join(' ') || null, next.labels.join(' ') || null],
    ['fixVersion', prev.fixVersions.join(', ') || null, next.fixVersions.join(', ') || null],
  ];
  return pairs
    .filter(([, a, b, differs = a !== b]) => differs)
    .map(([field, from, to]) => ({ id: `s${at}-${field}`, at, author: null, field, label: field, from, to }));
}

const str = value => (typeof value === 'string' ? value : '');
const list = value => (Array.isArray(value) ? value : []);

/** The text of an ADF date node: YYYY-MM-DD for a millisecond timestamp, else the raw value as written (the schema only asks
    for a string, and REST accepts "2026-10-17"). Never throws. */
function adfDate(timestamp) {
  const raw = typeof timestamp === 'number' ? String(timestamp) : str(timestamp);
  const ms = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN;
  return Number.isNaN(new Date(ms).getTime()) ? raw : new Date(ms).toISOString().slice(0, 10);
}

/** Readable text plus ranges of actual ADF mention nodes. No Jira markup or arbitrary attributes are stored. */
function adfContent(node) {
  const plain = text => ({ text, mentions: [] });
  const join = (parts, separator = '') => parts.reduce((out, part, i) => {
    if (i) out.text += separator;
    const offset = out.text.length;
    out.mentions.push(...part.mentions.map(m => ({ ...m, start: m.start + offset, end: m.end + offset })));
    out.text += part.text;
    return out;
  }, plain(''));
  const slice = (part, start, end) => ({
    text: part.text.slice(start, end),
    mentions: part.mentions.filter(m => m.start < end && m.end > start).map(m => ({
      ...m, start: Math.max(start, m.start) - start, end: Math.min(end, m.end) - start,
    })),
  });
  const trim = part => slice(part, part.text.length - part.text.trimStart().length, part.text.trimEnd().length);
  if (node == null) return plain('');
  if (typeof node === 'string') return plain(node);
  if (typeof node !== 'object') return plain('');
  const kids = () => join(list(node.content).map(adfContent));
  const block = () => join([kids(), plain('\n\n')]);
  switch (node.type) {
    case 'doc': {
      const part = kids();
      const pieces = [];
      let start = 0;
      for (const m of part.text.matchAll(/\n{3,}/g)) {
        pieces.push(slice(part, start, m.index), plain('\n\n'));
        start = m.index + m[0].length;
      }
      pieces.push(slice(part, start, part.text.length));
      return trim(join(pieces));
    }
    case 'text': return plain(str(node.text));
    case 'hardBreak': return plain('\n');
    case 'paragraph':
    case 'heading':
    case 'blockquote':
    case 'panel':
    case 'codeBlock': return block();
    case 'bulletList':
    case 'orderedList': return join([join(list(node.content).map((li, i) => join([
      plain(node.type === 'orderedList' ? `${i + 1}. ` : '• '), trim(adfContent(li)),
    ])), '\n'), plain('\n\n')]);
    case 'listItem': return kids();
    case 'mention': {
      const text = str(node.attrs?.text) || '@someone'; // Jira content, not UI chrome
      const accountId = node.attrs?.id;
      return { text, mentions: typeof accountId === 'string' && accountId ? [{ start: 0, end: text.length, accountId }] : [] };
    }
    case 'emoji': return plain(str(node.attrs?.text) || str(node.attrs?.shortName));
    case 'inlineCard':
    case 'blockCard': return plain(str(node.attrs?.url));
    case 'status': return plain(`[${str(node.attrs?.text)}]`);
    case 'date': return plain(adfDate(node.attrs?.timestamp));
    case 'mediaSingle':
    case 'mediaGroup': return plain('[attachment]\n\n');
    case 'media': return plain('');
    case 'rule': return plain('———\n\n');
    case 'table': return join([join(list(node.content).map(row => join(list(row?.content).map(cell => trim(adfContent(cell))), ' | ')), '\n'), plain('\n\n')]);
    default: return kids();
  }
}

/** Atlassian Document Format → readable plain text. */
const adfToText = node => adfContent(node).text;

/** Statuses to exclude from the stale list: the configured list, without (case-insensitive) duplicates (Backlog is just a status). */
function staleExcluded({ excluded }) {
  const list = (excluded || []).map(s => String(s).trim()).filter(Boolean);
  const seen = new Set();
  return list.filter(s => !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()));
}

/** Pattern from the settings: case-insensitive, * matches any characters, otherwise exact. "ARCHIVE-*" → /^ARCHIVE-.*$/i */
const wildcard = pattern => new RegExp(`^${pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');

/** Whether an issue is in an excluded project: each pattern applies to both the name and the key. Such issues don't count as stale. Nothing is excluded by default. */
function excludedProject({ excludedProjects = [] }) {
  const patterns = excludedProjects.map(wildcard);
  return issue => patterns.some(r => r.test(issue.project || '') || r.test(issue.projectKey || ''));
}

/** A JQL string: Jira reads \ and " inside quotes as escapes, so both are escaped and the value arrives exactly as typed. */
const quote = s => `"${String(s).replace(/[\\"]/g, '\\$&')}"`;

/** JQL for the stale list: issues of `people` (account ids), or your own without people; with staleUnassigned also
    issues without an assignee. Ordered by last updated: oldest on top by default, newest on top with staleSort 'newest'. */
function staleJql({ staleDays, excluded, people = [], skip = [], staleSort, staleUnassigned = false }) {
  const days = Math.max(1, parseInt(staleDays, 10) || 14);
  const skipped = new Set(skip.map(s => s.toLowerCase()));
  const statuses = staleExcluded({ excluded }).filter(s => !skipped.has(s.toLowerCase()));
  const assigned = people.length ? `assignee IN (${people.map(quote).join(', ')})` : 'assignee = currentUser()';
  const who = staleUnassigned ? `(${assigned} OR assignee IS EMPTY)` : assigned; // in parentheses: AND binds tighter than OR in JQL
  const notDone = ' AND statusCategory != Done'; // finished issues are never stale, whatever their status is called
  const notIn = statuses.length ? ` AND status NOT IN (${statuses.map(quote).join(', ')})` : '';
  return `${who}${notDone}${notIn} AND updated <= -${days}d ORDER BY updated ${staleSort === 'newest' ? 'DESC' : 'ASC'}`;
}

/** Quote characters around a name in a message: '…', "…", «…», „…“, “…”, ‘…’ and the like. */
const QUOTE_PAIRS = [["'", "'"], ['"', '"'], ['«', '»'], ['»', '«'], ['„', '“'], ['„', '”'], ['“', '”'], ['‘', '’']];
const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The statuses Jira's 400 says do not exist, out of the `sent` excluded statuses. `details` are Jira's own messages (JiraError.details),
    not IssueMon's wording around them. Jira words it as "The value 'Won't Fix' does not exist for the field 'status'." (the name may
    hold quotes, so the match runs up to the closing words, per message). In another language that fails; then the sent names that
    occur between quote characters in a message count. Without quotes a name proves nothing: "Fix" is also part of a word. */
function unknownStatuses(details, sent) {
  const messages = array(details).map(String);
  const listed = messages.flatMap(m => [...m.matchAll(/value '(.+?)' does not exist for the field 'status'/gi)].map(x => x[1]));
  if (listed.length) return listed;
  return sent.filter(name => messages.some(m => QUOTE_PAIRS.some(([open, close]) =>
    new RegExp(`${escapeRegExp(open)}\\s*${escapeRegExp(name)}\\s*${escapeRegExp(close)}`, 'i').test(m))));
}

module.exports = {
  parseJiraDate,
  normalizeIssue,
  changesFromChangelog,
  changesFromComments,
  commentIdOf,
  changesFromSnapshots,
  adfToText,
  staleJql,
  unknownStatuses,
  staleExcluded,
  excludedProject,
  ISSUE_FIELDS,
};
