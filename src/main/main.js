'use strict';
/* Electron main process: window, tray icon, notifications, storage and the bridge to the renderer. */

const os = require('node:os');
const path = require('node:path');
const {
  app, BrowserWindow, dialog, ipcMain, Menu, Notification, Tray, nativeImage, nativeTheme, net, powerMonitor, session, shell,
} = require('electron');
const { createStore } = require('./store');
const { resolveDataFile } = require('./paths');
const { createJiraClient } = require('./jira');
const { Tracker } = require('./tracker');
const { CHANNELS } = require('./ipc');
const { createSecrets } = require('./secrets');
const { createUpdateChecker, isReleaseUrl } = require('./updates');
const { isKey } = require('../shared/keys');
const { THEMES } = require('../shared/rules');
const { LANGUAGE_NAMES, LANGUAGE_SETTINGS, createTranslator, resolveLanguage, systemLocale } = require('../shared/i18n');

const E2E = process.env.ISSUEMON_E2E === '1';
const IS_MAC = process.platform === 'darwin';
const ASSETS = path.join(__dirname, '..', 'assets');
const TOKEN_PAGE = 'https://id.atlassian.com/manage-profile/security/api-tokens';
const NOTIFICATION_SETTINGS = 'x-apple.systempreferences:com.apple.Notifications-Settings.extension';

if (process.env.ISSUEMON_USER_DATA) app.setPath('userData', process.env.ISSUEMON_USER_DATA);
// Without this switch Chromium asks for the keychain item "IssueMon Safe Storage" as soon as it encrypts cookies.
// With a fixed key in the process, Chromium never touches the macOS keychain.
app.commandLine.appendSwitch('use-mock-keychain');
app.setAboutPanelOptions({ applicationName: 'IssueMon', copyright: 'Copyright © 2026 Fundament' });

let win = null;
let tray = null;
let store = null;
let tracker = null;
let updates = null; // the update checker (updates.js), once the tracker exists
let pendingUpdate = null; // an automatic result that waits for the window to be shown
let quitting = false;

/* ---------- API token: in the data file (see secrets.js) ---------- */

const tokens = createSecrets({ getStore: () => store });

function getClient() {
  const s = tracker.settings;
  const token = tokens.get();
  if (!s.baseUrl || !s.email || !token) return null;
  return createJiraClient({
    baseUrl: s.baseUrl,
    email: s.email,
    token,
    userAgent: `IssueMon/${app.getVersion()}`,
    fetch: (url, init) => net.fetch(url, init),
    t: tracker.t,
  });
}

/* ---------- theme and language ---------- */

/** The macOS locale that 'system' follows; only after ready. */
const osLocale = () => systemLocale(app.getLocale(), app.getPreferredSystemLanguages());

const windowBackground = () => (nativeTheme.shouldUseDarkColors ? '#1d1b19' : '#f5f2ed');

/** Light/dark for the whole app: also the window frame, scrollbars and prefers-color-scheme in the renderer. */
function applyTheme(theme) {
  nativeTheme.themeSource = THEMES.includes(theme) ? theme : 'system';
  if (win && !win.isDestroyed()) win.setBackgroundColor(windowBackground());
}

/* ---------- window ---------- */

function createWindow({ show = true } = {}) {
  win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 380,
    minHeight: 520,
    enableLargerThanScreen: E2E, // macOS clamps a window to the display; the e2e forces 1200 px wide even on a small CI display
    show: false,
    title: 'IssueMon',
    icon: path.join(ASSETS, 'icon.png'),
    backgroundColor: windowBackground(),
    // macOS: no title bar; the window buttons sit top left in the sidebar (see app.css, .platform-darwin)
    ...(IS_MAC && { titleBarStyle: 'hidden', trafficLightPosition: { x: 18, y: 18 } }),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (show) win.once('ready-to-show', () => win.show());
  // Close = hide; the app keeps checking in the background (tray icon).
  win.on('close', e => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('show', () => announceUpdate());
  win.on('closed', () => { win = null; });
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** Notification clicked (or a tray-menu item): bring the app to the front, straight to that issue's changes. */
function openIssue(key) {
  showWindow();
  afterLoad(() => send('focus', { key }));
}

/** Runs fn once the page is loaded (a window that was just created is still loading). */
function afterLoad(fn) {
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', fn);
  else fn();
}

/* ---------- updates ---------- */

/** An automatic check found a new release: the toast is only useful in a visible window, so it waits for one. */
function announceUpdate(result) {
  if (result) pendingUpdate = result;
  if (!pendingUpdate || !win || win.isDestroyed() || !win.isVisible()) return;
  const announced = pendingUpdate;
  pendingUpdate = null;
  if (tracker.updates.dismissed === announced.latest) return; // "Later" was clicked in the meantime
  afterLoad(() => send('updates', announced));
}

/** App menu → Check for Updates…: always checks, shows the window and answers with a toast. */
async function checkForUpdatesFromMenu() {
  showWindow();
  const result = await tracker.checkUpdates();
  if (win && !win.isDestroyed()) afterLoad(() => send('updates', { ...result, manual: true }));
}

/* ---------- notifications ---------- */

const liveNotifications = new Set(); // keep references, otherwise the click handler disappears
const keyFromId = id => /^issuemon:([A-Z][A-Z0-9_]*-\d+):/.exec(id || '')?.[1] || null;

function onNotificationClick(n, key) {
  liveNotifications.add(n);
  n.on('click', () => {
    liveNotifications.delete(n);
    openIssue(key);
  });
  n.on('close', () => liveNotifications.delete(n));
}

function reportNotification(result) {
  tracker.setNotificationStatus({ ...result, at: Date.now() });
  return result;
}

/** Shows a system notification. Resolves with { ok: true } if macOS shows it, { ok: false, error } if that fails, { ok: null } without an answer within 10 s. */
function notify({ title, subtitle, body, key }) {
  if (E2E) {
    (global.__issuemonNotifications ||= []).push({ title, subtitle, body, key });
    return Promise.resolve(reportNotification({ ok: true }));
  }
  if (!Notification.isSupported()) return Promise.resolve(reportNotification({ ok: false, error: tracker.t('error.notificationsUnsupported') }));
  const n = new Notification({
    id: `issuemon:${key || 'summary'}:${Date.now()}`, // key in the id: clicking also works after a restart
    groupId: key || 'issuemon',
    title,
    subtitle: IS_MAC ? subtitle : undefined,
    body: !IS_MAC && subtitle ? `${subtitle}\n${body}` : body,
  });
  onNotificationClick(n, key);
  return new Promise(resolve => {
    const done = result => { clearTimeout(timer); resolve(reportNotification(result)); };
    // No response: e.g. because macOS is still waiting for your permission.
    const timer = setTimeout(() => done({ ok: null, error: null }), 10_000);
    n.once('show', () => done({ ok: true }));
    n.once('failed', (_event, error) => done({ ok: false, error: String(error) }));
    n.show();
  });
}

/** Makes notifications from a previous session that are still in Notification Center clickable again. */
function restoreNotificationClicks() {
  if (!IS_MAC || typeof Notification.getHistory !== 'function') return;
  Notification.getHistory()
    .then(list => list.forEach(n => onNotificationClick(n, keyFromId(n.id))))
    .catch(() => {});
}

/* ---------- tray icon, dock badge, menu ---------- */

const TRAY_MAX = 10;
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** Context menu of the tray icon, with the changed issues (newest first, at most TRAY_MAX). */
function trayMenuTemplate() {
  const { t } = tracker;
  const changed = tracker.changedIssues();
  const issues = changed.length
    ? [
        { label: t('tray.changed', { n: changed.length }), enabled: false },
        ...changed.slice(0, TRAY_MAX).map(i => ({ label: `${i.key} · ${clip(i.summary, 48)}`, click: () => openIssue(i.key) })),
        ...(changed.length > TRAY_MAX ? [{ label: t('tray.more', { n: changed.length - TRAY_MAX }), enabled: false }] : []),
      ]
    : [{ label: t('tray.noChanges'), enabled: false }];
  return [
    { label: t('tray.open'), click: showWindow },
    { label: t('menu.checkNow'), click: () => tracker.check() },
    { type: 'separator' },
    ...issues,
    { type: 'separator' },
    { label: t('menu.settings'), click: () => { showWindow(); send('command', 'settings'); } },
    { type: 'separator' },
    { label: t('menu.quit'), click: () => app.quit() },
  ];
}

// Only set the menu again when the labels change: otherwise every push from the tracker would replace it
// (and close an open menu).
let trayLabels = null;
function applyTrayMenu() {
  const template = trayMenuTemplate();
  const labels = JSON.stringify(template.map(i => (i.type === 'separator' ? '-' : i.label)));
  if (labels === trayLabels) return;
  trayLabels = labels;
  tray.setContextMenu(Menu.buildFromTemplate(template));
  if (E2E) global.__issuemonTrayLabels = JSON.parse(labels); // what the menu really shows, for the test
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(ASSETS, IS_MAC ? 'trayTemplate.png' : 'tray.png'));
  if (IS_MAC) icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('IssueMon');
  applyTrayMenu();
  if (!IS_MAC) tray.on('click', showWindow);
}

function updateBadges() {
  const n = tracker.changedCount();
  app.setBadgeCount(n);
  if (tray) {
    if (IS_MAC) tray.setTitle(n ? String(n) : '');
    tray.setToolTip(n ? tracker.t('tray.tooltip', { n }) : 'IssueMon');
    applyTrayMenu();
  }
}

function command(name) {
  return () => { showWindow(); send('command', name); };
}

function createMenu() {
  const { t } = tracker;
  const template = [
    ...(IS_MAC ? [{
      label: app.name,
      submenu: [
        { role: 'about', label: t('menu.about') },
        { label: t('menu.checkUpdates'), click: checkForUpdatesFromMenu },
        { type: 'separator' },
        { label: t('menu.settings'), accelerator: 'CmdOrCtrl+,', click: command('settings') },
        { type: 'separator' },
        { role: 'services', label: t('menu.services') },
        { type: 'separator' },
        { role: 'hide', label: t('menu.hide', { app: app.name }) },
        { role: 'hideOthers', label: t('menu.hideOthers') },
        { role: 'unhide', label: t('menu.unhide') },
        { type: 'separator' },
        { role: 'quit', label: t('menu.quit') },
      ],
    }] : []),
    {
      label: t('menu.issues'),
      submenu: [
        { label: t('menu.track'), accelerator: 'CmdOrCtrl+L', click: command('add') },
        { label: t('menu.checkNow'), accelerator: 'CmdOrCtrl+R', click: () => tracker.check() },
        { type: 'separator' },
        { label: t('menu.changed'), accelerator: 'CmdOrCtrl+1', click: command('changed') },
        { label: t('menu.tracked'), accelerator: 'CmdOrCtrl+2', click: command('tracked') },
        { label: t('menu.stale'), accelerator: 'CmdOrCtrl+3', click: command('stale') },
        { label: t('menu.notes'), accelerator: 'CmdOrCtrl+4', click: command('notes') },
        ...(IS_MAC ? [] : [{ type: 'separator' }, { label: t('menu.settings'), accelerator: 'CmdOrCtrl+,', click: command('settings') }, { role: 'quit', label: t('menu.exit') }]),
      ],
    },
    // Cut/paste in input fields. Undo goes through the app: outside a field it reverts the last action.
    {
      label: t('menu.edit'),
      submenu: [
        { label: t('menu.undo'), accelerator: 'CmdOrCtrl+Z', click: () => send('command', 'undo') },
        { role: 'redo', label: t('menu.redo') },
        { type: 'separator' },
        { role: 'cut', label: t('menu.cut') },
        { role: 'copy', label: t('menu.copy') },
        { role: 'paste', label: t('menu.paste') },
        { role: 'selectAll', label: t('menu.selectAll') },
      ],
    },
    {
      label: t('menu.view'),
      submenu: [
        {
          label: t('menu.theme'),
          submenu: THEMES.map(value => ({
            label: t(`theme.${value}`), type: 'radio', checked: (tracker.settings.theme || 'system') === value, click: () => tracker.saveSettings({ theme: value }),
          })),
        },
        {
          label: t('menu.language'),
          submenu: LANGUAGE_SETTINGS.map(value => ({
            label: value === 'system' ? t('language.system') : LANGUAGE_NAMES[value],
            type: 'radio',
            checked: (LANGUAGE_SETTINGS.includes(tracker.settings.language) ? tracker.settings.language : 'system') === value,
            click: () => tracker.saveSettings({ language: value }),
          })),
        },
        { type: 'separator' },
        ...(app.isPackaged ? [] : [{ role: 'reload', label: t('menu.reload') }, { role: 'toggleDevTools', label: t('menu.devTools') }, { type: 'separator' }]),
        { role: 'resetZoom', label: t('menu.resetZoom') },
        { role: 'zoomIn', label: t('menu.zoomIn') },
        { role: 'zoomOut', label: t('menu.zoomOut') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('menu.fullscreen') },
      ],
    },
    // Spelled out instead of role 'windowMenu', whose items Electron labels in English; role 'window' keeps the macOS window list
    {
      label: t('menu.window'),
      role: 'window',
      submenu: [
        { role: 'minimize', label: t('menu.minimize') },
        ...(IS_MAC ? [{ role: 'zoom', label: t('menu.zoom') }, { type: 'separator' }, { role: 'front', label: t('menu.front') }] : []), // macOS-only roles
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------- IPC ---------- */

function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!win || event.sender !== win.webContents) throw new Error('Unknown sender');
    return fn(...args);
  });
}

function registerIpc() {
  for (const [channel, [method, ...coercions]] of Object.entries(CHANNELS)) {
    handle(channel, (...args) => tracker[method](...coercions.map((coerce, i) => coerce(args[i]))));
  }
  handle('settings:token', async token => {
    try {
      tokens.set(String(token || '').trim());
    } catch (err) {
      return { ok: false, message: err.message };
    }
    tracker.credentialsChanged();
    return tracker.configured() ? tracker.testConnection() : { ok: false, message: tracker.t('error.accountUrlEmail') };
  });
  handle('open:jira', async key => {
    if (!isKey(key) || !tracker.settings.baseUrl) return false;
    return openExternal(`${tracker.settings.baseUrl}/browse/${key}`);
  });
  handle('notify:test', () => notify({
    title: tracker.t('notify.test.title'),
    subtitle: tracker.t('notify.test.subtitle'),
    body: tracker.t('notify.test.body'),
    key: null,
  }));
  handle('open:url', async url => {
    if (url !== TOKEN_PAGE && !(IS_MAC && url === NOTIFICATION_SETTINGS) && !isReleaseUrl(url)) return false;
    return openExternal(url);
  });
}

/** In E2E mode, open nothing for real but record the URL so the test can check it. */
async function openExternal(url) {
  if (E2E) (global.__issuemonOpened ||= []).push(url);
  else await shell.openExternal(url);
  return true;
}

/* ---------- startup ---------- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  // Guards for every web contents, present and future: no navigation away from the app, no new windows.
  app.on('web-contents-created', (_, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', e => e.preventDefault());
  });

  app.whenReady().then(() => {
    // The page needs no permission: pasting uses paste events, and notifications come from this process.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    store = createStore(resolveDataFile({ env: process.env, homedir: os.homedir(), userData: app.getPath('userData') }));
    updates = createUpdateChecker({
      currentVersion: app.getVersion(),
      url: process.env.ISSUEMON_UPDATE_URL || undefined,
      fetch: (url, init) => net.fetch(url, init),
      getState: () => tracker.updates,
      setState: patch => tracker.setUpdates(patch),
      onResult: announceUpdate,
      // The developer's `npm start` and the e2e tests must not ask GitHub on their own; a manual check always works.
      enabled: () => tracker.settings.checkUpdates && app.isPackaged && !E2E,
      log: message => console.warn(message),
    });
    tracker = new Tracker({
      store,
      getClient,
      hasToken: () => tokens.has(),
      setToken: value => tokens.set(value),
      notify,
      env: { platform: process.platform, packaged: app.isPackaged, locale: osLocale() },
      version: app.getVersion(),
      updateChecker: updates,
    });

    let pushTimer = null;
    tracker.on('change', () => {
      if (pushTimer) return;
      pushTimer = setTimeout(() => {
        pushTimer = null;
        send('state', tracker.publicState());
        updateBadges();
      }, 40);
    });

    // Side effects of settings outside the tracker: every entry point (Settings, menu) passes through here.
    tracker.on('settings', ({ next, changed }) => {
      if (changed.includes('theme')) {
        applyTheme(next.theme);
        createMenu(); // update the checkmark in View → Theme
      }
      if (changed.includes('language')) {
        createMenu(); // new labels, and the checkmark in View → Language
        trayLabels = null; // the labels are new even when the issues are the same
        updateBadges(); // tooltip and tray menu
      }
      if (changed.includes('checkUpdates')) updates.start(); // switched on: a check is due again as soon as it was last made more than a day ago
      if (changed.includes('openAtLogin') && app.isPackaged) app.setLoginItemSettings({ openAtLogin: next.openAtLogin, openAsHidden: true });
    });

    applyTheme(tracker.settings.theme);
    nativeTheme.on('updated', () => { if (win && !win.isDestroyed()) win.setBackgroundColor(windowBackground()); });
    registerIpc();
    createMenu();
    createTray();
    const hidden = IS_MAC && app.getLoginItemSettings().wasOpenedAtLogin;
    createWindow({ show: !hidden });
    updateBadges();
    tracker.start();
    updates.start();
    restoreNotificationClicks();

    powerMonitor.on('resume', () => {
      if (tracker.configured()) tracker.schedule(5_000);
      updates.wake();
    });
    app.on('activate', showWindow);

    if (E2E) global.__issuemon = { tracker, openIssue, trayLabels: () => global.__issuemonTrayLabels || [] };
  }).catch(err => {
    // Otherwise a process keeps running without a window or tray icon, holding the single-instance lock.
    // The tracker (and its translator) may not exist yet: then the system language decides.
    const t = tracker?.t || createTranslator(resolveLanguage('system', osLocale()), osLocale());
    dialog.showErrorBox(t('error.startup'), err.message);
    app.exit(1);
  });

  app.on('before-quit', () => {
    quitting = true;
    tracker?.stop();
    updates?.stop();
    store?.flush();
  });

  app.on('window-all-closed', () => { /* keeps running in the menu bar */ });
}
