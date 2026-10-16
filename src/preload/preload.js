'use strict';
/* Bridge between renderer and main. Only what is exposed here is available in the page (window.issuemon). */

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, cb) => {
  const handler = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('issuemon', {
  platform: process.platform,
  getState: () => ipcRenderer.invoke('state:get'),
  onState: cb => on('state', cb),
  onFocus: cb => on('focus', cb),
  onCommand: cb => on('command', cb),
  onUpdates: cb => on('updates', cb),
  addIssues: text => ipcRenderer.invoke('issues:add', text),
  track: key => ipcRenderer.invoke('issues:track', key),
  untrack: key => ipcRenderer.invoke('issues:untrack', key),
  restore: key => ipcRenderer.invoke('issues:restore', key),
  markProcessed: keys => ipcRenderer.invoke('issues:mark', keys),
  unmark: ids => ipcRenderer.invoke('issues:unmark', ids),
  checkNow: () => ipcRenderer.invoke('check:now'),
  addNote: text => ipcRenderer.invoke('notes:add', text),
  editNote: (id, text) => ipcRenderer.invoke('notes:edit', id, text),
  setNoteDone: (id, done) => ipcRenderer.invoke('notes:done', id, done),
  moveNote: (id, index) => ipcRenderer.invoke('notes:move', id, index),
  removeNote: id => ipcRenderer.invoke('notes:remove', id),
  restoreNote: id => ipcRenderer.invoke('notes:restore', id),
  activity: key => ipcRenderer.invoke('issues:activity', key),
  issueTypes: project => ipcRenderer.invoke('issues:types', project),
  createIssueFromNote: (id, overrides) => ipcRenderer.invoke('notes:issue', id, overrides),
  saveSettings: patch => ipcRenderer.invoke('settings:save', patch),
  setToken: token => ipcRenderer.invoke('settings:token', token),
  testConnection: () => ipcRenderer.invoke('settings:test'),
  loadPeople: force => ipcRenderer.invoke('people:load', !!force),
  openInJira: key => ipcRenderer.invoke('open:jira', key),
  openTokenPage: () => ipcRenderer.invoke('open:url', 'https://id.atlassian.com/manage-profile/security/api-tokens'),
  openNotificationSettings: () => ipcRenderer.invoke('open:url', 'x-apple.systempreferences:com.apple.Notifications-Settings.extension'),
  checkUpdates: () => ipcRenderer.invoke('updates:check'),
  dismissUpdate: () => ipcRenderer.invoke('updates:dismiss'),
  openRelease: url => ipcRenderer.invoke('open:url', url),
  testNotification: () => ipcRenderer.invoke('notify:test'),
});
