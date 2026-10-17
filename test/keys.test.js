'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseKeys, isKey } = require('../src/shared/keys');

test('takes the key from a browse URL', () => {
  assert.deepEqual(parseKeys('https://example.atlassian.net/browse/WEB-1423'), ['WEB-1423']);
});

test('takes the key from a board URL with selectedIssue', () => {
  assert.deepEqual(parseKeys('https://x.atlassian.net/jira/software/projects/WEB/boards/12?selectedIssue=WEB-77'), ['WEB-77']);
});

test('accepts lowercase and multiple keys, without duplicates', () => {
  assert.deepEqual(parseKeys('web-1, APP-2\nops-3 WEB-1'), ['WEB-1', 'APP-2', 'OPS-3']);
});

test('bare numbers get the default project', () => {
  assert.deepEqual(parseKeys('1423', 'web'), ['WEB-1423']);
  assert.deepEqual(parseKeys('#12, 13', 'APP'), ['APP-12', 'APP-13']);
});

test('bare numbers without a default project yield nothing', () => {
  assert.deepEqual(parseKeys('1423'), []);
});

test('bare numbers get the default project next to real keys, as long as the text is a list', () => {
  assert.deepEqual(parseKeys('1398 APP-52', 'WEB'), ['WEB-1398', 'APP-52']);
  assert.deepEqual(parseKeys('WEB-1 1423', 'APP'), ['WEB-1', 'APP-1423']);
  assert.deepEqual(parseKeys('APP-52, #7 web-3 7', 'WEB'), ['APP-52', 'WEB-7', 'WEB-3']);
  assert.deepEqual(parseKeys('#12, 13', 'WEB'), ['WEB-12', 'WEB-13']);
});

test('bare numbers in running text are ignored', () => {
  assert.deepEqual(parseKeys('Can you check WEB-1423? Takes 2 days', 'WEB'), ['WEB-1423']);
  assert.deepEqual(parseKeys('Takes 2 days', 'WEB'), []);
  assert.deepEqual(parseKeys('WEB-1 and 1423', 'APP'), ['WEB-1']);
});

test('a URL with a key counts as a key in a list', () => {
  assert.deepEqual(parseKeys('https://x/browse/WEB-1?focusedCommentId=12345 7', 'APP'), ['WEB-1', 'APP-7']);
});

test('bare numbers next to real keys are still ignored without a default project', () => {
  assert.deepEqual(parseKeys('1398 APP-52'), ['APP-52']);
});

test('a number in a URL parameter does not become a bare number', () => {
  assert.deepEqual(parseKeys('https://x.atlassian.net/browse/WEB-1?focusedCommentId=123', 'APP'), ['WEB-1']);
});

test('a sandbox link or a host ending in digits yields only the issue key', () => {
  assert.deepEqual(parseKeys('https://acme-sandbox-952.atlassian.net/browse/WEB-12'), ['WEB-12']);
  assert.deepEqual(parseKeys('https://team-42.atlassian.net/browse/WEB-12'), ['WEB-12']);
  assert.deepEqual(parseKeys('acme-sandbox-952.atlassian.net/browse/WEB-12'), ['WEB-12']);
});

test('a link to a comment yields only the issue key', () => {
  const url = 'https://acme.atlassian.net/browse/WEB-12?focusedCommentId=10234&page=com.atlassian.jira.plugin.system.issuetabpanels%3Acomment-tabpanel#comment-10234';
  assert.deepEqual(parseKeys(url), ['WEB-12']);
  assert.deepEqual(parseKeys(`(${url})`), ['WEB-12']);
});

test('keys in a jql parameter of a link are ignored', () => {
  assert.deepEqual(parseKeys('https://acme.atlassian.net/browse/WEB-12?jql=key%20%3D%20WEB-3'), ['WEB-12']);
  assert.deepEqual(parseKeys('https://acme.atlassian.net/jira/software/projects/WEB/issues?jql=key%20%3D%20WEB-3'), []);
});

test('board, backlog and queue links yield the key in the path or in selectedIssue', () => {
  assert.deepEqual(parseKeys('https://x.atlassian.net/jira/software/projects/WEB/boards/12?selectedIssue=WEB-77&jql=key%3DWEB-3#WEB-4'), ['WEB-77']);
  assert.deepEqual(parseKeys('https://x.atlassian.net/jira/software/c/projects/WEB/issues/WEB-12'), ['WEB-12']);
  assert.deepEqual(parseKeys('https://x.atlassian.net/jira/servicedesk/projects/SD/queues/custom/1/SD-5/'), ['SD-5']);
});

test('a pasted list of links and plain keys gives all keys in order', () => {
  const text = 'APP-1, https://acme-sandbox-952.atlassian.net/browse/WEB-12#comment-10234\nhttps://x.atlassian.net/jira/software/projects/WEB/boards/1?selectedIssue=OPS-3 ops-4 7';
  assert.deepEqual(parseKeys(text, 'DEF'), ['APP-1', 'WEB-12', 'OPS-3', 'OPS-4', 'DEF-7']);
});

test('a link wrapped in markup, quotes or punctuation still yields its key', () => {
  const url = 'https://x.atlassian.net/browse/WEB-1';
  const wrapped = [
    `**${url}**`, `\`${url}\``, `“${url}”`, `«${url}»`, `${url}}`, `${url})。`, `${url}%20`,
    `<${url}|WEB-1>`, `[WEB-1](${url})`, `(${url}).`, `'${url}'`, `${url}>`, `${url}.`,
  ];
  for (const text of wrapped) assert.deepEqual(parseKeys(text), ['WEB-1'], text);
});

test('only a whole key at the end of the path counts', () => {
  assert.deepEqual(parseKeys('https://x.atlassian.net/browse/WEB-12-login'), []);
  assert.deepEqual(parseKeys('https://x.atlassian.net/browse/WEB-12345678'), []);
});

test('several links in one token give all their keys', () => {
  assert.deepEqual(parseKeys('https://a.atlassian.net/browse/WEB-1|https://b-sandbox-952.atlassian.net/browse/APP-2'), ['WEB-1', 'APP-2']);
  assert.deepEqual(parseKeys('<https://a.atlassian.net/browse/WEB-1><https://a.atlassian.net/browse/WEB-3>'), ['WEB-1', 'WEB-3']);
});

test('text that only looks like a host and a path is not a link', () => {
  assert.deepEqual(parseKeys('ABC-1.ABC-2/x'), ['ABC-1', 'ABC-2']);
});

test('isKey validates strictly', () => {
  assert.equal(isKey('WEB-1423'), true);
  assert.equal(isKey('web-1423'), false);
  assert.equal(isKey('WEB-1423/../x'), false);
});
