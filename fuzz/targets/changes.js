'use strict';
/* main/changes.js: ADF to text and mentions, comment edits over time, the Stale JQL and the excluded projects. */

const { adfToText, normalizeIssue, changesFromComments, commentIdOf, staleJql, staleExcluded, excludedProject } = require('../../src/main/changes');
const { jiraDate } = require('../../test/support/mock-jira');
const { fail, same } = require('../lib/property');
const { docOf, nodes, MENTION_IDS } = require('../lib/adf');
const { createWorld } = require('../lib/world');

// adfContent is internal; normalizeIssue keeps only the text, changesFromComments also the mention ranges.
const contentOf = body => {
  const [c] = changesFromComments([{ id: '1', created: '2026-01-01T00:00:00.000+0000', body }], null);
  return { text: c.to, mentions: c.mentions || [] };
};

/* ---------- comment edits over time: the tracker's use of changesFromComments, without the network ---------- */

const PEOPLE = [{ accountId: 'acc-alex', displayName: 'Alex' }, { accountId: 'acc-sam', displayName: 'Sam' }];
const bodyOf = (text, mention) => ({
  type: 'doc', version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }, ...(mention ? [{ type: 'text', text: ' ' }, { type: 'mention', attrs: { id: mention, text: '@You' } }] : [])] }],
});

/** Events on one issue's comments, checks in between. Some comments exist before tracking starts. */
function genTimeline(r) {
  const events = [];
  const before = r.int(0, 3);
  for (let i = 0; i < before; i++) events.push({ op: 'comment', text: r.plainText(4) || 'x', mention: r.bool(0.2) ? 'acc-me' : null, early: true });
  const n = r.int(1, 30);
  for (let i = 0; i < n; i++) {
    events.push(r.weighted([
      [3, () => ({ op: 'comment', text: r.plainText(4) || 'x', mention: r.bool(0.2) ? 'acc-me' : null })],
      [3, () => ({ op: 'edit', which: r.int(0, 50), text: r.plainText(4) || 'x', mention: r.bool(0.2) ? 'acc-me' : null })],
      [2, () => ({ op: 'resave', which: r.int(0, 50) })], // saved without a change, or only the visibility changed
      [3, () => ({ op: 'check' })],
      [1, () => ({ op: 'wait', ms: r.int(1, 5) })],
    ]));
  }
  events.push({ op: 'check' });
  return events;
}

/** Like Tracker.commentTexts: the latest text and mentions recorded per comment id. */
function recordedTexts(changes) {
  const texts = new Map();
  for (const c of [...changes].sort((a, b) => a.at - b.at)) {
    const id = commentIdOf(c);
    if (id) texts.set(id, { text: c.to ?? '', mentions: c.mentions || [] });
  }
  return texts;
}

function replayTimeline(events) {
  let clock = 1_700_000_000_000;
  let seq = 100;
  const comments = [];
  let issueUpdated = clock;
  let baseline = null;
  let since = null;
  const changes = [];
  const known = new Set();
  const lastEventAt = new Map(); // comment id → time of its last event after the baseline
  const api = () => comments.map(c => ({
    id: c.id, author: c.author, updateAuthor: c.updateAuthor, body: bodyOf(c.text, c.mention),
    created: jiraDate(c.created), updated: jiraDate(c.updated),
  }));
  for (const e of events) {
    clock += 1;
    if (baseline == null && !e.early) { baseline = issueUpdated; since = baseline; clock += 1; }
    if (e.op === 'comment') {
      const c = { id: String(++seq), author: PEOPLE[seq % 2], text: e.text, mention: e.mention, created: clock, updated: clock };
      comments.push(c);
      issueUpdated = clock;
      if (!e.early) lastEventAt.set(c.id, clock);
    } else if ((e.op === 'edit' || e.op === 'resave') && comments.length) {
      const c = comments[e.which % comments.length];
      if (e.op === 'edit') Object.assign(c, { text: e.text, mention: e.mention });
      Object.assign(c, { updated: clock, updateAuthor: PEOPLE[(seq + 1) % 2] });
      issueUpdated = clock;
      lastEventAt.set(c.id, clock);
    } else if (e.op === 'wait') {
      clock += e.ms;
    } else if (e.op === 'check' && baseline != null) {
      if (issueUpdated <= since) continue;
      const previous = recordedTexts(changes);
      const found = changesFromComments(api(), since, previous);
      for (const c of found.sort((a, b) => a.at - b.at)) {
        if (known.has(c.id)) continue;
        known.add(c.id);
        if (c.edited && c.from != null) {
          const prior = previous.get(commentIdOf(c));
          if (prior && prior.text === c.to && same(prior.mentions, c.mentions || [])) fail('unchanged-edit', `an edit of comment ${commentIdOf(c)} that changed nothing is reported`, { change: c });
          if (prior && prior.text !== c.from) fail('wrong-from', 'an edit does not start from the last text IssueMon saw', { change: c, prior });
        }
        changes.push(c);
      }
      since = Math.max(since, issueUpdated);
      const texts = recordedTexts(changes);
      for (const c of comments) {
        if (c.created > baseline && !known.has(`c${c.id}`)) fail('missed-comment', `new comment ${c.id} was not reported`, { comment: c });
        if (!lastEventAt.has(c.id)) continue;
        const rec = texts.get(c.id);
        const current = contentOf(bodyOf(c.text, c.mention));
        if (!rec || rec.text !== current.text) fail('stale-text', `the text IssueMon recorded for comment ${c.id} is not its current text`, { recorded: rec, current: current.text });
      }
    }
  }
}

/* ---------- JQL: a small lexer for quoted strings, to read back what staleJql wrote ---------- */

const ESCAPES = { '"': '"', "'": "'", '\\': '\\', n: '\n', t: '\t', r: '\r', ' ': ' ' };

/** JQL tokens: { s } for a quoted string (decoded), { p } for ( ) and ,, { w } for any other word. Throws on a broken string. */
function lexJql(jql) {
  const out = [];
  let i = 0;
  while (i < jql.length) {
    const ch = jql[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '"' || ch === "'") {
      let s = '';
      i++;
      for (;;) {
        if (i >= jql.length) throw new Error(`unterminated string in ${jql}`);
        const c = jql[i];
        if (c === ch) { i++; break; }
        if (c === '\\') {
          const e = jql[i + 1];
          if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(jql.slice(i + 2, i + 6))) { s += String.fromCharCode(parseInt(jql.slice(i + 2, i + 6), 16)); i += 6; continue; }
          if (!(e in ESCAPES)) throw new Error(`illegal escape \\${e ?? ''} in ${jql}`);
          s += ESCAPES[e];
          i += 2;
          continue;
        }
        s += c;
        i++;
      }
      out.push({ s });
    } else if ('(),'.includes(ch)) {
      out.push({ p: ch });
      i++;
    } else {
      let w = '';
      while (i < jql.length && !/[\s(),"']/.test(jql[i])) w += jql[i++];
      out.push({ w });
    }
  }
  return out;
}

/** The quoted values of the list after `words` (such as status NOT IN), or null when the clause is missing. */
function listAfter(tokens, words) {
  for (let i = 0; i + words.length < tokens.length; i++) {
    if (!words.every((w, k) => tokens[i + k].w?.toUpperCase() === w)) continue;
    const values = [];
    let k = i + words.length;
    if (tokens[k]?.p !== '(') return null;
    for (k++; k < tokens.length && tokens[k].p !== ')'; k++) if ('s' in tokens[k]) values.push(tokens[k].s);
    return values;
  }
  return null;
}

/* ---------- excluded projects: a reference glob ---------- */

/** * matches any text, everything else itself, case-insensitively (ASCII and é). */
function globMatch(pattern, text) {
  const p = pattern.toLowerCase(), s = text.toLowerCase();
  const dp = Array.from({ length: p.length + 1 }, () => new Array(s.length + 1).fill(false));
  dp[0][0] = true;
  for (let i = 1; i <= p.length; i++) {
    for (let j = 0; j <= s.length; j++) {
      dp[i][j] = p[i - 1] === '*' ? dp[i - 1][j] || (j > 0 && dp[i][j - 1]) : j > 0 && dp[i - 1][j - 1] && p[i - 1] === s[j - 1];
    }
  }
  return dp[p.length][s.length];
}

let world = null;
const KNOWN_STATUSES = ['To Do', 'Backlog', 'In Progress', 'Review', 'Blocked', 'Done'];

const STATUS_ALPHABET = ['a', 'B', ' ', 'é', "'", '"', '\\', '(', ')', ',', '-', 'Ö', '\t', '日', 'n', '\\n', '\\"'];

const properties = [
  {
    name: 'adf.mentions',
    description: 'ADF text has no outer whitespace or 3+ newlines; every mention node gives one in-bounds, ordered range over its own text.',
    runs: 2000,
    gen: r => docOf(r),
    check(doc) {
      const { text, mentions } = contentOf(doc);
      if (text !== text.trim()) fail('outer-whitespace', 'text starts or ends with whitespace', { text });
      if (/\n{3,}/.test(text)) fail('blank-lines', 'text contains three or more newlines in a row', { text });
      const mentionNodes = [...nodes(doc)].filter(n => n.type === 'mention' && typeof n.attrs?.id === 'string' && n.attrs.id);
      if (mentions.length !== mentionNodes.length) fail('mention-count', `${mentionNodes.length} mention nodes but ${mentions.length} ranges`, { text, mentions });
      mentions.forEach((m, i) => {
        if (!(Number.isInteger(m.start) && Number.isInteger(m.end) && m.start >= 0 && m.start < m.end && m.end <= text.length)) fail('mention-bounds', 'a mention range outside the text', { text, m });
        if (i && mentions[i - 1].end > m.start) fail('mention-order', 'mention ranges overlap or are out of order', { mentions });
        const piece = text.slice(m.start, m.end);
        if (!mentionNodes.some(n => (n.attrs.text || '@someone').includes(piece))) fail('mention-text', `the range "${piece}" is not the text of a mention`, { text, m });
        if (!MENTION_IDS.includes(m.accountId)) fail('mention-id', 'a range with an unknown account id', { m });
      });
    },
  },
  {
    name: 'adf.robust',
    description: 'A description or comment in schema-valid ADF never makes normalizeIssue or changesFromComments throw (one bad node would stop every check).',
    runs: 1500,
    gen: r => docOf(r, { robust: true }),
    check(doc) {
      normalizeIssue({ id: '10001', key: 'WEB-1', fields: { summary: 'x', updated: '2026-01-01T00:00:00.000+0000', description: doc } });
      contentOf(doc);
      adfToText(doc);
    },
  },
  {
    name: 'comments.timeline',
    description: 'Over checks, every new comment is reported once, an edit starts from the last seen text, saves without a change are quiet, and the recorded text ends current.',
    runs: 2000,
    gen: genTimeline,
    check: replayTimeline,
  },
  {
    name: 'jql.quoting',
    description: 'The Stale JQL is well formed and quotes every excluded status and person so Jira reads back exactly the configured values.',
    runs: 2500,
    gen(r) {
      const status = () => r.array(() => r.pick(STATUS_ALPHABET), 1, 8).join('').replace(/\\n/g, '\n');
      return {
        excluded: r.array(status, 0, 4),
        people: r.array(() => r.pick(['acc-1', '5b10a2844c20165700ede21g', '712020:9f6c-0b1e', 'qm:1a2b:3c4d']), 0, 3),
        staleDays: r.int(1, 365),
        staleSort: r.pick(['oldest', 'newest']),
        staleUnassigned: r.bool(),
      };
    },
    check(settings) {
      const jql = staleJql(settings);
      let tokens;
      try {
        tokens = lexJql(jql);
      } catch (err) {
        fail('malformed-jql', err.message, { jql, excluded: settings.excluded });
      }
      const want = staleExcluded(settings);
      const got = listAfter(tokens, ['STATUS', 'NOT', 'IN']) ?? [];
      if (!same(got, want)) fail('status-mismatch', `Jira would read the excluded statuses as ${JSON.stringify(got)}, not ${JSON.stringify(want)}`, { jql });
      if (settings.people.length && !same(listAfter(tokens, ['ASSIGNEE', 'IN']), settings.people)) fail('people-mismatch', 'assignee IN does not list the people', { jql });
    },
  },
  {
    name: 'jql.unknownStatus',
    description: 'Excluded statuses your Jira does not know are skipped with a warning naming them, and the Stale list still loads (README, Stale).',
    runs: 300,
    gen(r) {
      // Names the mock Jira can read back: no comma or parenthesis; with apostrophes, double quotes and backslashes.
      const unknown = r.array(() => `${r.pick(['Won', 'Wait', 'Parked', 'Klaar', 'Geparkt', 'À faire', 'Qa'])}${r.pick(['', "'t", ' ', '-', "'", '\\', '"'])}${r.pick(['', 'Fix', 'Do', ' for QA', ' 2'])}`.trim() || 'Parked', 0, 3);
      return { known: r.array(() => r.pick(KNOWN_STATUSES), 0, 2), unknown: [...new Set(unknown)].filter(u => !KNOWN_STATUSES.some(k => k.toLowerCase() === u.toLowerCase())) };
    },
    async check({ known, unknown }) {
      world ||= await createWorld();
      const { tracker } = world;
      tracker.data.settings.excluded = [...known, ...unknown];
      tracker.data.stale = { issues: [], fetchedAt: null, error: null };
      await tracker.refreshStale(tracker.getClient());
      const { error, warning } = tracker.data.stale;
      if (error) fail('stale-error', `excluding ${JSON.stringify(unknown)} (unknown) breaks the Stale list: ${error}`);
      const missing = unknown.filter(u => !warning?.includes(u));
      if (missing.length) fail('no-warning', `the warning does not name the unknown ${JSON.stringify(missing)}`, { warning });
    },
    teardown: () => world?.stop(),
  },
  {
    name: 'projects.wildcard',
    description: 'An excluded-project pattern matches a project name or key exactly like a glob where only * is special, case-insensitively.',
    runs: 3000,
    gen(r) {
      const alphabet = ['a', 'B', 'c', 'é', 'É', '-', '_', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '^', '$', '|', '\\', '/', ' ', '1'];
      const pattern = r.array(() => r.pick(alphabet), 0, 6).join('');
      const name = r.bool(0.5) ? pattern.replace(/\*/g, () => r.string(['x', '*', '-', 'A'], 0, 3)) : r.array(() => r.pick(alphabet), 0, 6).join('');
      return { pattern, name, key: r.string('ABC_1', 1, 4) };
    },
    check({ pattern, name, key }) {
      const want = globMatch(pattern, name) || globMatch(pattern, key);
      let got;
      try {
        got = excludedProject({ excludedProjects: [pattern] })({ project: name, projectKey: key });
      } catch (err) {
        fail('pattern-throws', `the pattern ${JSON.stringify(pattern)} throws ${err.message}`);
      }
      if (got !== want) fail('pattern-mismatch', `pattern ${JSON.stringify(pattern)} on ${JSON.stringify(name)}/${key}: ${got}, expected ${want}`);
    },
  },
];

module.exports = { properties };
