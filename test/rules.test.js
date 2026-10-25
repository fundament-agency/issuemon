'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { NOTE_MAX, INTERVALS, THEMES, noteText, projectKey, isConfigured, defaultIssueType, localDay, daysUntilDue, dueMarker } = require('../src/shared/rules');

test('noteText: whitespace and newlines become one space, trimmed', () => {
  assert.equal(noteText('  one\n\n two\t three  '), 'one two three');
  assert.equal(noteText('\n  '), '');
  assert.equal(noteText(null), '');
});

test('noteText: cut off at NOTE_MAX between grapheme clusters', () => {
  assert.equal(noteText('x'.repeat(300)).length, NOTE_MAX);
  const cut = noteText(`${'x'.repeat(NOTE_MAX - 1)}👩‍💻`);
  assert.equal(cut, 'x'.repeat(NOTE_MAX - 1)); // the whole emoji stays out, never half of it
  assert.ok(cut.isWellFormed());
  assert.equal(noteText(undefined), '');
});

test('noteText truncates at 255 characters', () => {
  assert.equal(NOTE_MAX, 255);
  assert.equal(noteText('x'.repeat(300)).length, 255);
});

test('projectKey: uppercase, odd characters removed, an empty value stays empty', () => {
  assert.equal(projectKey(' web-1_x '), 'WEB1_X');
  assert.equal(projectKey('ops'), 'OPS');
  assert.equal(projectKey('Ünï!'), 'N');
  assert.equal(projectKey(''), '');
  assert.equal(projectKey(null), '');
  assert.equal(projectKey(undefined), '');
});

test('isConfigured: URL, email and token are all three required', () => {
  const s = { baseUrl: 'https://x.atlassian.net', email: 'user@example.com' };
  assert.equal(isConfigured(s, true), true);
  assert.equal(isConfigured({ ...s, baseUrl: '' }, true), false);
  assert.equal(isConfigured({ ...s, email: '' }, true), false);
  assert.equal(isConfigured(s, false), false);
  assert.equal(isConfigured(s, undefined), false);
  assert.equal(isConfigured({}, true), false);
});

test('defaultIssueType: Task or a localised name, case-insensitive, otherwise the first', () => {
  const bug = { id: '1', name: 'Bug' };
  const task = { id: '2', name: 'Task' };
  const taak = { id: '3', name: 'TAAK' };
  assert.equal(defaultIssueType([bug, task]), task);
  assert.equal(defaultIssueType([bug, taak]), taak);
  assert.equal(defaultIssueType([bug, { id: '4', name: 'Subtask' }]), bug);
  assert.equal(defaultIssueType([{ id: '5', name: 'Mytask' }]).id, '5');
  assert.equal(defaultIssueType([]), null);
});

test('defaultIssueType: also the French, German and Spanish name of Task, as a whole name', () => {
  const bug = { id: '1', name: 'Bug' };
  for (const name of ['Tâche', 'TÂCHE', 'Aufgabe', 'aufgabe', 'Tarea']) assert.equal(defaultIssueType([bug, { id: '2', name }]).id, '2', name);
  assert.equal(defaultIssueType([bug, { id: '2', name: 'Unteraufgabe' }]), bug);
  assert.equal(defaultIssueType([bug, { id: '2', name: 'Subtarea' }]), bug);
});

test('INTERVALS and THEMES are the allowed values', () => {
  assert.deepEqual(INTERVALS, [5, 10, 15, 30, 60]);
  assert.deepEqual(THEMES, ['system', 'light', 'dark']);
});

test('localDay: the local calendar day as YYYY-MM-DD', () => {
  assert.equal(localDay(new Date(2026, 9, 18, 23, 59)), '2026-10-18');
  assert.equal(localDay(new Date(2026, 0, 5, 0, 0)), '2026-01-05');
});

test('daysUntilDue: calendar days from today, negative when overdue, null without a valid date', () => {
  const today = '2026-10-18';
  assert.equal(daysUntilDue('2026-10-21', today), 3);
  assert.equal(daysUntilDue('2026-10-18', today), 0);
  assert.equal(daysUntilDue('2026-10-16', today), -2);
  assert.equal(daysUntilDue('2027-01-01', '2026-12-31'), 1); // across a year
  assert.equal(daysUntilDue('2026-03-30', '2026-03-28'), 2); // across a daylight saving change
  assert.equal(daysUntilDue(null, today), null);
  assert.equal(daysUntilDue('', today), null);
  assert.equal(daysUntilDue('2026-02-31', today), null);
  assert.equal(daysUntilDue('18-10-2026', today), null);
});

test('dueMarker: overdue or due today for unfinished issues only', () => {
  const today = '2026-10-18';
  assert.equal(dueMarker({ due: '2026-10-17', statusCat: 'indeterminate' }, today), 'overdue');
  assert.equal(dueMarker({ due: '2026-10-18', statusCat: 'new' }, today), 'today');
  assert.equal(dueMarker({ due: '2026-10-19', statusCat: 'new' }, today), null); // no "due soon"
  assert.equal(dueMarker({ due: '2026-10-01', statusCat: 'done' }, today), null);
  assert.equal(dueMarker({ due: '2026-10-18', statusCat: 'done' }, today), null);
  assert.equal(dueMarker({ due: null, statusCat: 'new' }, today), null);
  assert.equal(dueMarker({ statusCat: 'new' }, today), null); // stored before IssueMon knew due dates
  assert.equal(dueMarker(null, today), null);
});
