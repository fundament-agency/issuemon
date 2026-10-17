'use strict';
/* Pure functions: Jira responses → normalized issues and changes. No Electron, no network. */

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
const ISSUE_FIELDS = ['summary', 'status', 'assignee', 'priority', 'issuetype', 'updated', 'labels', 'fixVersions', 'project', 'parent', 'subtasks', 'issuelinks'];

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
    description: adfToText(f.description).slice(0, DESCRIPTION_MAX),
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

/**
 * Changelog histories → changes, only after `since` (exclusive).
 * @returns {Array<{id,at,author,field,label,from,to}>}
 */
function changesFromChangelog(histories, since) {
  const out = [];
  for (const h of histories || []) {
    const at = parseJiraDate(h.created);
    if (at == null || (since != null && at <= since)) continue;
    (h.items || []).forEach((item, idx) => {
      if (IGNORED_FIELDS.has(item.field)) return;
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
 * every edit counts once); `previous` (comment id → text IssueMon saw before) gives its old text, else `from` is null.
 * A comment IssueMon already saw counts only as an edit, and not when its text is unchanged (a save without changes,
 * or a new visibility).
 */
function changesFromComments(comments, since, previous = new Map()) {
  const out = [];
  for (const c of comments || []) {
    const at = parseJiraDate(c.created);
    if (at == null) continue;
    const to = adfToText(c.body);
    const seen = previous.get(String(c.id));
    if ((since == null || at > since) && seen === undefined) {
      out.push({ id: `c${c.id}`, at, author: user(c.author), field: 'comment', label: 'Comment', from: null, to });
      continue;
    }
    const edited = parseJiraDate(c.updated);
    if (edited == null || (since != null && edited <= since) || seen === to) continue;
    out.push({
      id: `c${c.id}@${edited}`, at: edited, author: user(c.updateAuthor || c.author), field: 'comment', label: 'Comment',
      edited: true, from: seen ?? null, to,
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

/** Atlassian Document Format → readable plain text. */
function adfToText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  const kids = () => (node.content || []).map(adfToText).join('');
  switch (node.type) {
    case 'doc': return kids().replace(/\n{3,}/g, '\n\n').trim();
    case 'text': return node.text || '';
    case 'hardBreak': return '\n';
    case 'paragraph':
    case 'heading':
    case 'blockquote':
    case 'panel': return `${kids()}\n\n`;
    case 'bulletList':
    case 'orderedList': return `${(node.content || []).map((li, i) => `${node.type === 'orderedList' ? `${i + 1}.` : '•'} ${adfToText(li).trim()}`).join('\n')}\n\n`;
    case 'listItem': return kids();
    case 'codeBlock': return `${kids()}\n\n`;
    case 'mention': return node.attrs?.text || '@someone'; // markers inside Jira text, not UI chrome: neutral English
    case 'emoji': return node.attrs?.text || node.attrs?.shortName || '';
    case 'inlineCard':
    case 'blockCard': return node.attrs?.url || '';
    case 'status': return `[${node.attrs?.text || ''}]`;
    case 'date': return node.attrs?.timestamp ? new Date(+node.attrs.timestamp).toISOString().slice(0, 10) : '';
    case 'mediaSingle':
    case 'mediaGroup': return '[attachment]\n\n';
    case 'media': return '';
    case 'rule': return '———\n\n';
    case 'table': return `${(node.content || []).map(row => (row.content || []).map(cell => adfToText(cell).trim()).join(' | ')).join('\n')}\n\n`;
    default: return kids();
  }
}

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

const quote = s => `"${String(s).replace(/"/g, '\\"')}"`;

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

module.exports = {
  parseJiraDate,
  normalizeIssue,
  changesFromChangelog,
  changesFromComments,
  commentIdOf,
  changesFromSnapshots,
  adfToText,
  staleJql,
  staleExcluded,
  excludedProject,
  ISSUE_FIELDS,
};
