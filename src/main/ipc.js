'use strict';
/* The channels that map straight onto a Tracker method: channel → [method name, ...coercions].
   Each coercion normalizes the argument at its position; arguments beyond the coercions are not passed on.
   No Electron import, so this can be tested in node. The channels with their own logic live in main.js. */

const id = v => String(v);
const text = v => String(v || '');
const list = v => [].concat(v).map(String);
const flag = v => !!v;
const number = v => Number(v);
const object = v => v || {};
const force = v => ({ force: !!v });

const CHANNELS = {
  'state:get': ['publicState'],
  'issues:add': ['addIssues', text],
  'issues:track': ['track', id],
  'issues:untrack': ['untrack', id],
  'issues:restore': ['restore', id],
  'issues:mark': ['markProcessed', list],
  'issues:unmark': ['unmark', list],
  'issues:activity': ['activity', text],
  'issues:types': ['issueTypes', text],
  'check:now': ['check'],
  'notes:add': ['addNote', text],
  'notes:edit': ['editNote', id, text],
  'notes:done': ['setNoteDone', id, flag],
  'notes:move': ['moveNote', id, number],
  'notes:remove': ['removeNote', id],
  'notes:restore': ['restoreNote', id],
  'notes:issue': ['createIssueFromNote', id, object],
  'settings:save': ['saveSettings', object],
  'settings:test': ['testConnection'],
  'people:load': ['loadPeople', force],
  'updates:check': ['checkUpdates'],
  'updates:dismiss': ['dismissUpdate'],
};

module.exports = { CHANNELS };
