'use strict';
/* shared/keys.js: recognising issue keys in pasted text. */

const { parseKeys, isKey } = require('../../src/shared/keys');
const { fail, same } = require('../lib/property');

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const projectOf = r => r.pick(LETTERS) + r.string(`${LETTERS}0123456789_`, 1, r.int(1, 9));
const keyOf = r => `${projectOf(r)}-${r.int(1, 9_999_999)}`;
const lower = s => s.toLowerCase();

/** A Jira Cloud site name: words, digits and hyphens, as people pick them. */
const siteOf = r => r.array(() => r.weighted([[5, () => r.string('abcdefghijklmnopqrstuvwxyz', 2, 9)], [2, () => String(r.int(1, 999))]]), 1, 3).join('-');

/** A Jira URL that points at exactly one issue, with the extras Jira itself adds to links. */
function jiraUrl(r, key) {
  const project = key.split('-')[0];
  const host = r.weighted([[6, () => `${siteOf(r)}.atlassian.net`], [1, () => `${siteOf(r)}.jira.com`]]);
  const pathAndQuery = r.pick([
    () => [`/browse/${key}`, []],
    () => [`/jira/software/projects/${project}/boards/${r.int(1, 999)}`, [`selectedIssue=${key}`]],
    () => [`/jira/software/c/projects/${project}/boards/${r.int(1, 999)}/backlog`, [`selectedIssue=${key}`]],
    () => [`/jira/software/c/projects/${project}/issues/${key}`, ['jql=project%20%3D%20%22' + project + '%22']],
    () => [`/jira/servicedesk/projects/${project}/queues/custom/${r.int(1, 99)}/${key}`, []],
    () => [`/jira/core/projects/${project}/board`, [`selectedIssue=${key}`]],
  ])();
  const [p, query] = pathAndQuery;
  const comment = r.int(10_000, 99_999);
  const extras = r.shuffle([
    ...(r.bool(0.3) ? [`focusedCommentId=${comment}`] : []),
    ...(r.bool(0.2) ? [`page=com.atlassian.jira.plugin.system.issuetabpanels${r.pick([':', '%3A'])}comment-tabpanel`] : []),
    ...(r.bool(0.2) ? [`atlOrigin=${r.string('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 16, 40)}`] : []),
    ...(r.bool(0.1) ? ['filter=allissues'] : []),
    ...(r.bool(0.1) ? [`sourceType=mention`] : []),
  ]);
  const all = [...query, ...extras];
  const fragment = r.weighted([[6, ''], [1, `#comment-${comment}`], [1, '#']]);
  return `https://${host}${p}${all.length ? `?${all.join('&')}` : ''}${fragment}`;
}

const properties = [
  {
    name: 'keys.url',
    description: 'A pasted Jira link to one issue yields exactly that issue key (README: "Paste a URL (/browse/ABC-1, ?selectedIssue=ABC-1)").',
    runs: 3000,
    gen(r) {
      const key = keyOf(r);
      return { key, url: jiraUrl(r, key) };
    },
    // While shrinking, the key stays a whole key in the URL (not "R4-3" inside "R4-30").
    valid: ({ key, url }) => isKey(key) && new RegExp(`(^|[^A-Za-z0-9_])${key}($|[^A-Za-z0-9_])`).test(url),
    check({ key, url }) {
      const got = parseKeys(url, '');
      if (!same(got, [key])) fail('url-extra-keys', `parseKeys(url) = ${JSON.stringify(got)}, expected ${JSON.stringify([key])}`, { url });
    },
  },
  {
    name: 'keys.list',
    description: 'A list of keys and bare numbers gives the keys in order of appearance, numbers with the default project, without duplicates.',
    runs: 3000,
    gen(r) {
      const project = r.bool(0.8) ? projectOf(r) : '';
      const items = r.array(() => r.weighted([
        [3, () => ({ key: keyOf(r), lower: r.bool(0.3) })],
        [2, () => ({ number: r.int(1, 9_999_999), hash: r.bool(0.4) })],
      ]), 1, 8);
      const separators = r.array(() => r.pick([' ', ',', ', ', ';', '\n', '\t', ' ; ', ',,']), items.length, items.length);
      return { project: r.bool(0.2) ? lower(project) : project, items, separators };
    },
    check({ project, items, separators }) {
      const tokens = items.map(it => (it.key ? (it.lower ? lower(it.key) : it.key) : `${it.hash ? '#' : ''}${it.number}`));
      const text = tokens.map((tok, i) => tok + separators[i]).join('');
      const want = [];
      for (const it of items) {
        const k = it.key ? it.key : project ? `${project.toUpperCase()}-${it.number}` : null;
        if (k && !want.includes(k)) want.push(k);
      }
      const got = parseKeys(text, project);
      if (!same(got, want)) fail('list-mismatch', `parseKeys(${JSON.stringify(text)}, ${JSON.stringify(project)}) = ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
    },
  },
  {
    name: 'keys.stable',
    description: 'Every key parseKeys returns is a valid key, and parsing its own output again gives the same list.',
    runs: 3000,
    gen(r) {
      const parts = r.array(() => r.weighted([[3, () => r.text(4)], [2, () => keyOf(r)], [1, () => String(r.int(0, 99_999_999))], [1, () => `#${r.int(1, 999)}`]]), 0, 8);
      return { text: parts.join(r.pick([' ', ',', '', '\n', '/'])), project: r.bool(0.7) ? projectOf(r) : '' };
    },
    check({ text, project }) {
      const got = parseKeys(text, project);
      const bad = got.filter(k => !isKey(k));
      if (bad.length) fail('invalid-key', `parseKeys returned invalid keys ${JSON.stringify(bad)}`);
      const again = parseKeys(got.join(' '), project);
      if (!same(again, got)) fail('not-idempotent', `parseKeys(parseKeys(text).join(' ')) = ${JSON.stringify(again)}, expected ${JSON.stringify(got)}`);
    },
  },
];

module.exports = { properties };
