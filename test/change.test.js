'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fieldLabel, fieldInSentence, clip, sameName, assignedToMe, firstName, describe, shortLine, chip } = require('../src/shared/change');
const { createTranslator } = require('../src/shared/i18n');

const nl = createTranslator('nl');

const Sam = { name: 'Sam Rivera' };
const toMe = { field: 'assignee', from: 'Jordan Lee', to: 'Demo User', author: { name: 'Alex' } };

test('fieldLabel: known field, unknown field with label, otherwise the field itself', () => {
  assert.equal(fieldLabel({ field: 'status' }), 'Status');
  assert.equal(fieldLabel({ field: 'fixVersion' }), 'Fix version');
  assert.equal(fieldLabel({ field: 'other', label: 'Story Points' }), 'Story Points');
  assert.equal(fieldLabel({ field: 'other' }), 'other');
  assert.equal(fieldLabel({ field: 'priority' }), 'Priority');
  assert.equal(fieldLabel({ field: 'priority' }, nl), 'Prioriteit');
  assert.equal(fieldLabel({ field: 'other', label: 'Story Points' }, nl), 'Story Points'); // Jira's own label stays
});

test('fieldInSentence: lower-cased where the language says so, otherwise as is', () => {
  assert.equal(fieldInSentence({ field: 'priority' }), 'priority');
  assert.equal(fieldInSentence({ field: 'other', label: 'Story Points' }), 'story points');
  assert.equal(fieldInSentence({ field: 'priority' }, nl), 'prioriteit');
  const keep = Object.assign(key => (key === 'meta.fieldInSentence' ? 'keep' : key === 'field.priority' ? 'Priorität' : key), { locale: 'de-DE' });
  assert.equal(fieldInSentence({ field: 'priority' }, keep), 'Priorität');
  assert.equal(fieldInSentence({ field: 'other', label: 'Story Points' }, keep), 'Story Points');
});

test('clip truncates with an ellipsis', () => {
  assert.equal(clip('kort', 10), 'kort');
  assert.equal(clip('1234567890', 10), '1234567890');
  assert.equal(clip('12345678901', 10), '123456789…');
});

test('sameName: trimmed and case-insensitive; empty values are never equal', () => {
  assert.equal(sameName('Demo User', 'demo user'), true);
  assert.equal(sameName('  Demo User ', 'DEMO USER'), true);
  assert.equal(sameName('Demo User', 'Sam Rivera'), false);
  assert.equal(sameName('', ''), false);
  assert.equal(sameName(null, 'Demo'), false);
  assert.equal(sameName('Demo', undefined), false);
});

test('assignedToMe: only an assignee change to your display name', () => {
  assert.equal(assignedToMe(toMe, 'Demo User'), true);
  assert.equal(assignedToMe(toMe, ' demo user '), true);
  assert.equal(assignedToMe(toMe, 'Sam Rivera'), false);
  assert.equal(assignedToMe(toMe, ''), false);
  assert.equal(assignedToMe(toMe, undefined), false);
  assert.equal(assignedToMe({ ...toMe, to: null }, 'Demo User'), false);
  assert.equal(assignedToMe({ ...toMe, field: 'reporter' }, 'Demo User'), false);
});

test('firstName is the first word of the name', () => {
  assert.equal(firstName({ name: ' Sam  Rivera ' }), 'Sam');
  assert.equal(firstName({ name: 'Alex' }), 'Alex');
});

test('describe: comment with whitespace as a single space and truncated at 110', () => {
  assert.equal(describe({ field: 'comment', to: 'Can you\n take a look?', author: { name: 'Sam' } }), 'Sam: “Can you take a look?”');
  const lang = describe({ field: 'comment', to: 'x'.repeat(200), author: { name: 'Sam' } });
  assert.equal(lang, `Sam: “${'x'.repeat(109)}…”`);
  assert.equal(describe({ field: 'comment', to: null, author: null }), 'Someone: “”');
});

test('describe: description, and attachment added or removed', () => {
  assert.equal(describe({ field: 'description', author: { name: 'Alex' } }), 'Alex edited the description');
  assert.equal(describe({ field: 'attachment', to: 'a.png', author: { name: 'Alex' } }), 'Alex added a.png');
  assert.equal(describe({ field: 'attachment', from: 'a.png', to: null, author: { name: 'Alex' } }), 'Alex removed a.png');
  assert.equal(describe({ field: 'attachment', from: null, to: null, author: { name: 'Alex' } }), 'Alex removed an attachment');
});

test('describe: an assignment to you is shorter; without me it keeps the regular form', () => {
  assert.equal(describe(toMe, { me: 'Demo User' }), 'Alex · Assigned to you');
  assert.equal(describe(toMe, { me: ' demo user ' }), 'Alex · Assigned to you');
  assert.equal(describe(toMe), 'Alex · Assignee: Jordan Lee → Demo User');
  assert.equal(describe({ ...toMe, to: 'Sam Rivera' }, { me: 'Demo User' }), 'Alex · Assignee: Jordan Lee → Sam Rivera');
  assert.equal(describe(toMe, { me: 'Demo User', t: nl }), 'Alex · Toegewezen aan jou');
});

test('describe: standard field with "empty" for missing values', () => {
  assert.equal(describe({ field: 'status', from: 'To Do', to: 'Review', author: { name: 'Alex' } }), 'Alex · Status: To Do → Review');
  assert.equal(describe({ field: 'other', label: 'Sprint', from: null, to: 'S12', author: null }), 'Someone · Sprint: empty → S12');
  assert.equal(describe({ field: 'labels', from: 'a', to: null, author: { name: 'Alex' } }), 'Alex · Labels: a → empty');
  assert.equal(describe({ field: 'priority', from: null, to: 'High', author: null }, { t: nl }), 'Iemand · Prioriteit: leeg → High');
});

test('shortLine: who did it (you, first name, someone)', () => {
  const c = { field: 'comment', author: { name: 'Sam Rivera' } };
  assert.equal(shortLine(c, { authorIsMe: true }), 'You commented');
  assert.equal(shortLine(c, {}), 'Sam commented');
  assert.equal(shortLine({ ...c, author: null }), 'Someone commented');
  assert.equal(shortLine({ ...c, author: { name: '  ' } }), 'Someone commented');
  assert.equal(shortLine(c, { authorIsMe: true, t: nl }), 'Jij reageerde');
  assert.equal(shortLine({ ...c, author: null }, { t: nl }), 'Iemand reageerde');
});

test('an edited comment: "edited a comment" with the new text', () => {
  const c = { field: 'comment', edited: true, from: 'Waiting.', to: 'Legal approved the text,\n can ship.', author: Sam };
  assert.equal(describe(c), 'Sam Rivera edited a comment: “Legal approved the text, can ship.”');
  assert.equal(describe(c, { t: nl }), 'Sam Rivera paste een reactie aan: “Legal approved the text, can ship.”');
  assert.equal(shortLine(c, {}), 'Sam edited a comment');
  assert.equal(shortLine(c, { authorIsMe: true }), 'You edited a comment');
});

test('shortLine: status, priority and removed values', () => {
  const by = { author: Sam };
  assert.equal(shortLine({ ...by, field: 'status', to: 'Done' }), 'Sam set it to Done');
  assert.equal(shortLine({ ...by, field: 'status', to: null }), 'Sam set it to empty');
  assert.equal(shortLine({ ...by, field: 'status', to: 'x'.repeat(40) }), `Sam set it to ${'x'.repeat(23)}…`);
  assert.equal(shortLine({ ...by, field: 'priority', to: 'High' }), 'Sam set the priority to High');
  assert.equal(shortLine({ ...by, field: 'status', to: null }, { t: nl }), 'Sam zette op leeg');
  assert.equal(shortLine({ ...by, field: 'status', to: 'Done' }, { authorIsMe: true }), 'You set it to Done');
});

test('shortLine: assignment to you, to someone else and removed', () => {
  const by = { author: Sam, field: 'assignee' };
  assert.equal(shortLine({ ...by, to: 'Demo User' }, { me: 'demo user' }), 'Sam assigned it to you');
  assert.equal(shortLine({ ...by, to: 'Alex Fox' }, { me: 'Demo User' }), 'Sam assigned it to Alex Fox');
  assert.equal(shortLine({ ...by, to: 'Alex Fox' }), 'Sam assigned it to Alex Fox');
  assert.equal(shortLine({ ...by, to: null, from: 'Alex' }, { me: 'Demo User' }), 'Sam removed the assignee');
  assert.equal(shortLine({ ...by, to: 'Demo User' }, { me: 'Demo User', authorIsMe: true }), 'You assigned it to yourself');
  assert.equal(shortLine({ ...by, to: 'Demo User' }, { me: 'demo user', t: nl }), 'Sam wees toe aan jou');
});

test('shortLine: description, title, attachment and other', () => {
  const by = { author: Sam };
  assert.equal(shortLine({ ...by, field: 'description' }), 'Sam edited the description');
  assert.equal(shortLine({ ...by, field: 'summary' }), 'Sam edited the title');
  assert.equal(shortLine({ ...by, field: 'attachment', to: 'a.png' }), 'Sam added an attachment');
  assert.equal(shortLine({ ...by, field: 'attachment', to: null, from: 'a.png' }), 'Sam removed an attachment');
  assert.equal(shortLine({ ...by, field: 'sprint', to: 'S12' }), 'Sam changed sprint');
  assert.equal(shortLine({ ...by, field: 'other', label: 'Story Points' }), 'Sam changed story points');
  assert.equal(shortLine({ ...by, field: 'priority', to: 'High' }, { t: nl }), 'Sam zette prioriteit op High');
  assert.equal(shortLine({ ...by, field: 'sprint', to: 'S12' }, { t: nl }), 'Sam wijzigde sprint');
  assert.equal(shortLine({ ...by, field: 'summary' }, { authorIsMe: true, t: nl }), 'Jij paste de titel aan');
});

test('chip: an assignment to you is mine', () => {
  assert.deepEqual(chip(toMe, { me: 'Demo User' }), { text: 'Assigned → you', mine: true });
  assert.deepEqual(chip(toMe, { me: ' DEMO user' }), { text: 'Assigned → you', mine: true });
  assert.deepEqual(chip(toMe, { me: 'Demo User', t: nl }), { text: 'Toegewezen → jou', mine: true });
});

test('chip: assignment to someone else, without me and removed', () => {
  assert.deepEqual(chip({ ...toMe, to: 'Sam Rivera' }, { me: 'Demo User' }), { text: 'Assigned → Sam Rivera', mine: false });
  assert.deepEqual(chip(toMe), { text: 'Assigned → Demo User', mine: false });
  assert.deepEqual(chip({ ...toMe, to: null }, { me: 'Demo User' }), { text: 'Assignee removed', mine: false });
  assert.equal(chip({ ...toMe, to: 'x'.repeat(40) }).text, `Assigned → ${'x'.repeat(27)}…`);
});

test('chip: description, attachment and title', () => {
  assert.deepEqual(chip({ field: 'description' }), { text: 'Description edited', mine: false });
  assert.deepEqual(chip({ field: 'attachment', to: 'a.png' }), { text: 'Attachment added', mine: false });
  assert.deepEqual(chip({ field: 'attachment', to: null, from: 'a.png' }), { text: 'Attachment removed', mine: false });
  assert.deepEqual(chip({ field: 'attachment', to: 'a.png' }, { t: nl }), { text: 'Bijlage toegevoegd', mine: false });
  assert.deepEqual(chip({ field: 'summary' }), { text: 'Title edited', mine: false });
});

test('chip: default with field label and truncated at 28', () => {
  assert.deepEqual(chip({ field: 'status', to: 'Done' }), { text: 'Status → Done', mine: false });
  assert.deepEqual(chip({ field: 'priority', to: null }), { text: 'Priority → empty', mine: false });
  assert.deepEqual(chip({ field: 'priority', to: null }, { t: nl }), { text: 'Prioriteit → leeg', mine: false });
  assert.equal(chip({ field: 'sprint', to: 'x'.repeat(40) }).text, `Sprint → ${'x'.repeat(27)}…`);
});

test('a vanished issue: the same words everywhere, without an author', () => {
  const gone = { field: 'gone', author: null, from: null, to: null };
  const text = 'No longer accessible (deleted, or you no longer have access)';
  assert.equal(describe(gone), text);
  assert.equal(shortLine(gone), text);
  assert.equal(shortLine(gone, { authorIsMe: true }), text);
  assert.deepEqual(chip(gone), { text: 'No longer accessible', mine: false });
  assert.equal(describe(gone, { t: nl }), 'Niet meer toegankelijk (verwijderd, of je hebt er geen toegang meer toe)');
  assert.deepEqual(chip(gone, { t: nl }), { text: 'Niet meer toegankelijk', mine: false });
});

test('comment mentions get a personal chip and notification line, including edits', () => {
  const c = { field: 'comment', mentionsMe: true, author: Sam, to: '@Demo User' };
  assert.deepEqual(chip(c), { text: 'Mentions you', mine: true });
  assert.equal(describe(c, { key: 'WEB-1423' }), 'Sam Rivera mentioned you on WEB-1423');
  assert.equal(describe({ ...c, edited: true }, { key: 'WEB-1423' }), 'Sam Rivera mentioned you on WEB-1423');
  assert.equal(describe({ ...c, mentionsMe: false }), 'Sam Rivera: “@Demo User”');
  assert.equal(chip({ ...c, field: 'description' }).mine, false);
});

test('rankChanges: assignment, mention, flagged risk, then newest; ties use id without mutating input', () => {
  const { rankChanges } = require('../src/shared/change');
  const changes = Object.freeze([
    { id: 'z', field: 'comment', at: 90 },
    { id: 'b', field: 'status', at: 100 },
    { id: 'a', field: 'status', at: 100 },
    { id: 'risk', field: 'priority', risk: true, at: 80 },
    { id: 'mention', field: 'comment', mentionsMe: true, at: 70 },
    { ...toMe, id: 'assignment', at: 60 },
    { id: 'old-mention', field: 'comment', mentionsMe: true, at: 50 },
  ].map(Object.freeze));
  assert.deepEqual(rankChanges(changes, 'Demo User').map(c => c.id), ['assignment', 'mention', 'old-mention', 'risk', 'a', 'b', 'z']);
  assert.equal(changes[0].id, 'z');
  assert.equal(rankChanges(changes)[0].id, 'mention');
  assert.deepEqual(rankChanges([], 'Demo User'), []);
});
