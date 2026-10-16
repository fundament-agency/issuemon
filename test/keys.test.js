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

test('isKey validates strictly', () => {
  assert.equal(isKey('WEB-1423'), true);
  assert.equal(isKey('web-1423'), false);
  assert.equal(isKey('WEB-1423/../x'), false);
});
