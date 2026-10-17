'use strict';
/* main/ipc.js + main/tracker.js: every renderer → main channel, called the way main.js calls it (with the coercions),
 * with arbitrary structured-clone arguments. Whatever the arguments, the stored state must stay well formed. */

const { CHANNELS } = require('../../src/main/ipc');
const { ensureShape } = require('../../src/main/tracker');
const { INTERVALS, THEMES, NOTE_MAX } = require('../../src/shared/rules');
const { LANGUAGE_SETTINGS } = require('../../src/shared/i18n');
const { createWorld } = require('../lib/world');
const { fail, same } = require('../lib/property');

const CHANNEL_NAMES = Object.keys(CHANNELS);

function genValue(r, depth = 0) {
  return r.weighted([
    [3, () => r.pick([undefined, null, true, false, 0, -1, 1, 5, 2.5, 1e9, -0, NaN, Infinity, -Infinity])],
    [4, () => r.pick(['', ' ', 'WEB-1', 'web-2 OPS-1', 'x', '10', '5', 'dark', 'nl', 'oldest', 'newest', 'Backlog, On hold', 'ARCHIVE-*', 'https://acme.atlassian.net', 'http://evil.example', 'a'.repeat(300), 'line\nbreak', '\u0000', '__proto__', 'constructor', 'toString'])],
    [depth < 2 ? 2 : 0, () => r.array(() => genValue(r, depth + 1), 0, 3)],
    [depth < 2 ? 3 : 0, () => {
      const keys = ['baseUrl', 'email', 'token', 'defaultProject', 'notesProject', 'interval', 'staleDays', 'stalePeople', 'staleFilter', 'excluded', 'excludedProjects',
        'notify', 'ignoreOwn', 'openAtLogin', 'staleUnassigned', 'checkUpdates', 'theme', 'staleSort', 'language', 'summary', 'project', 'typeId', 'accountId', 'name', '__proto__'];
      return Object.fromEntries(r.array(() => [r.pick(keys), genValue(r, depth + 1)], 0, 4));
    }],
  ]);
}

/** A call names its channel; a note id is mostly that of an existing note, so the note channels reach their logic. */
function genCalls(r) {
  return r.array(() => ({
    channel: r.pick(CHANNEL_NAMES.filter(c => c !== 'check:now' && c !== 'settings:test')),
    args: r.array(() => genValue(r), 0, 3),
    note: r.bool(0.7) ? r.int(0, 9) : null,
  }), 1, 25);
}

const isStrings = v => Array.isArray(v) && v.every(x => typeof x === 'string');

function checkState(data) {
  const s = data.settings;
  const bad = [];
  if (typeof s.baseUrl !== 'string' || typeof s.email !== 'string') bad.push('baseUrl/email');
  if (!/^[A-Z0-9_]*$/.test(s.defaultProject) || !/^[A-Z0-9_]*$/.test(s.notesProject)) bad.push('project');
  if (!INTERVALS.includes(s.interval)) bad.push('interval');
  if (!(Number.isInteger(s.staleDays) && s.staleDays >= 1 && s.staleDays <= 365)) bad.push('staleDays');
  if (!['newest', 'oldest'].includes(s.staleSort)) bad.push('staleSort');
  if (!THEMES.includes(s.theme)) bad.push('theme');
  if (!LANGUAGE_SETTINGS.includes(s.language)) bad.push('language');
  for (const k of ['notify', 'ignoreOwn', 'openAtLogin', 'staleUnassigned', 'checkUpdates']) if (typeof s[k] !== 'boolean') bad.push(k);
  for (const k of ['staleFilter', 'excluded', 'excludedProjects']) if (!isStrings(s[k])) bad.push(k);
  if (!Array.isArray(s.stalePeople) || s.stalePeople.some(p => typeof p?.accountId !== 'string' || !p.accountId || typeof p.name !== 'string')) bad.push('stalePeople');
  if (bad.length) fail('bad-setting', `a channel stored a malformed setting: ${bad.join(', ')}`, { settings: Object.fromEntries(bad.map(k => [k, s[k]])) });
  for (const n of data.notes) {
    if (typeof n.id !== 'string' || typeof n.text !== 'string' || !n.text || n.text.length > NOTE_MAX || /\s{2}|\n/.test(n.text) || n.creating) fail('bad-note', 'a malformed note is stored', { note: n });
  }
  const ids = data.notes.map(n => n.id);
  if (new Set(ids).size !== ids.length) fail('duplicate-note', 'two notes share an id');
  const saved = JSON.parse(JSON.stringify(data));
  if (!same(ensureShape(JSON.parse(JSON.stringify(data))), saved)) fail('restart-changes-state', 'restarting would change the stored state');
}

let world = null;

const properties = [
  {
    name: 'ipc.channels',
    description: 'Any arguments on any renderer → main channel leave the stored settings, notes and tracked issues well formed.',
    runs: 300,
    async check(calls) {
      world ||= await createWorld();
      const { tracker, jira } = world;
      // Fresh state per case on the shared mock.
      tracker.store.data = ensureShape({ settings: { baseUrl: jira.url, email: 'user@example.com' } });
      tracker.removed.clear();
      tracker.removedNotes.clear();
      if (!jira.issues.has('WEB-1')) jira.addIssue({ key: 'WEB-1', summary: 'One' });
      for (const text of ['First note', 'Second note', 'Third']) tracker.addNote(text);
      for (const { channel, args, note } of calls) {
        const [method, ...coercions] = CHANNELS[channel];
        const notes = tracker.data.notes;
        const values = [...args];
        if (note != null && notes.length && /^notes:/.test(channel)) values[0] = notes[note % notes.length].id;
        try {
          await tracker[method](...coercions.map((coerce, i) => coerce(values[i])));
        } catch {
          // A rejected call is an answer the renderer handles; the state is what matters.
        }
        await world.drain();
        checkState(tracker.data);
      }
    },
    gen: genCalls,
    teardown: () => world?.stop(),
  },
];

module.exports = { properties };
