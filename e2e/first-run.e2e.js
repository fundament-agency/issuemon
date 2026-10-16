'use strict';
/* End-to-end: the first run. An empty store, no token: IssueMon opens the connect screen and, after
   connecting, leads to the first issue. The token goes into the data file (mode 0600); the
   keychain is not used.  Usage: npm run test:e2e */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');
const { createMockJira, seedDemo } = require('../test/support/mock-jira');

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(__dirname, 'screenshots');

test('First run: connect and carry on', { timeout: 120_000 }, async t => {
  const jira = createMockJira({ email: 'e2e@example.com', token: 'e2e-token' });
  seedDemo(jira);
  const url = await jira.start();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'issuemon-first-run-'));
  const dataDir = path.join(userData, 'data');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'issuemon.json'), JSON.stringify({ settings: { language: 'en' } }), { mode: 0o600 }); // English, whatever the Mac's language
  fs.mkdirSync(SHOTS, { recursive: true });
  const dataFile = path.join(dataDir, 'issuemon.json');

  let app;
  t.after(async () => {
    await app?.close().catch(() => {});
    await jira.stop();
    fs.rmSync(userData, { recursive: true, force: true });
  });

  const env = { ...process.env, ISSUEMON_E2E: '1', ISSUEMON_USER_DATA: userData, ISSUEMON_HOME: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ISSUEMON_TOKEN; // otherwise the token comes from the environment and the app stores nothing
  app = await electron.launch({ executablePath: require('electron'), args: [ROOT], env });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 780)); // CI displays are small: force the desktop layout
  await page.waitForFunction(() => window.innerWidth > 1100);
  page.on('pageerror', err => console.error('[renderer-error]', err.message));
  page.on('console', msg => { if (msg.type() === 'error' || msg.type() === 'warning') console.error(`[renderer-${msg.type()}]`, msg.text()); });
  t.afterEach(async ctx => {
    if (ctx?.passed === false || ctx?.failed) await page.screenshot({ path: path.join(SHOTS, `error-${Date.now()}.png`) }).catch(() => {});
  });
  await page.emulateMedia({ colorScheme: null });
  const focusedId = () => page.evaluate(() => document.activeElement?.id);

  await t.test('starts on the connect screen', async () => {
    await page.waitForSelector('.va-connect');
    assert.equal(await page.textContent('.va-connect h1'), 'Connect IssueMon to Jira');
    assert.match(await page.textContent('.va-sync'), /Not connected/);
    assert.equal(await page.locator('.va-nav button.on').count(), 0);
    await page.waitForFunction(() => document.activeElement?.id === 'conn-baseUrl');
    assert.equal(await page.getAttribute('#conn-token', 'placeholder'), 'Paste your API token here');
  });

  await t.test('Connect in the sidebar puts the cursor in the first empty field', async () => {
    await page.click('#conn-email'); // focus somewhere else
    await page.click('.va-sync [data-view="connect"]');
    assert.equal(await focusedId(), 'conn-baseUrl');
  });

  await t.test('without a connection the empty screens point to Connect', async () => {
    await page.click('.va-nav [data-view="changed"]');
    assert.match(await page.textContent('.va-list'), /Connect|not tracking any/);
    assert.doesNotMatch(await page.textContent('.va-detail'), /Select an issue/);
    await page.click('.va-nav [data-view="stale"]');
    assert.match(await page.textContent('.va-list'), /Connect your Jira account first/);
    assert.match(await page.textContent('.va-detail'), /Connect your Jira account first/);
    assert.match(await page.textContent('.va-list [data-view="connect"]'), /Connect/);
    await page.click('.va-list [data-view="connect"]');
    await page.waitForSelector('.va-connect');
  });

  await t.test('pasting a key without a connection keeps the text and offers Connect', async () => {
    await page.click('.va-nav [data-view="tracked"]');
    await page.fill('#add-input', 'WEB-1423');
    await page.press('#add-input', 'Enter');
    await page.waitForSelector('.snack.warn');
    assert.match(await page.textContent('.snack.warn'), /Connect your Jira account first/);
    assert.equal(await page.inputValue('#add-input'), 'WEB-1423');
    await page.click('.snack.warn button:has-text("Connect")');
    await page.waitForSelector('.va-connect');
  });

  await t.test('an incomplete form gives a message', async () => {
    await page.fill('#conn-baseUrl', url);
    await page.click('[data-action="connect"]');
    assert.match(await page.textContent('.va-connect .conn.err'), /Enter your Jira URL, email address and API token/);
    assert.equal(await focusedId(), 'conn-email');
    assert.equal(await page.inputValue('#conn-baseUrl'), url);
  });

  await t.test('a wrong token gives an error message on the screen', async () => {
    await page.fill('#conn-email', 'e2e@example.com');
    await page.fill('#conn-token', 'wrong-token');
    await page.press('#conn-token', 'Enter'); // Enter submits the form
    await page.waitForSelector('.va-connect .conn.err:has-text("Login failed")');
    assert.equal(await page.locator('.va-connect h1').textContent(), 'Connect IssueMon to Jira');
  });

  await t.test('connecting shows the next steps', async () => {
    await page.fill('#conn-token', 'e2e-token');
    await page.click('[data-action="connect"]');
    await page.waitForSelector('.va-connect :text("Connected as Demo User")');
    await page.waitForSelector('.va-connect [data-action="connect-done"]');
    assert.match(await page.textContent('.va-connect [data-action="connect-done"]'), /Track your first issue/);
    await page.waitForSelector('.va-connect :text("You have 4 stale issues")'); // after the first check; nothing is excluded by default, so the Backlog issue counts too
    await page.waitForSelector('.va-sync .live:not(.off)');
    await page.screenshot({ path: path.join(SHOTS, '13-first-run.png') });
  });

  await t.test('"Track your first issue" opens Tracked with the paste field focused', async () => {
    await page.click('[data-action="connect-done"]');
    assert.equal(await page.textContent('.va-list-title h1'), 'Tracked');
    assert.equal(await focusedId(), 'add-input');
    assert.equal(await page.inputValue('#add-input'), 'WEB-1423'); // the key pasted earlier is still there
    assert.equal(await page.textContent('.ap.ok'), 'WEB-1423');
  });

  await t.test('Changed explains what to do while you track nothing', async () => {
    await page.click('.va-nav [data-view="changed"]');
    assert.match(await page.textContent('.va-list'), /not tracking any issues yet/);
    assert.match(await page.textContent('.va-detail'), /Nothing to show yet/);
    await page.click('.va-detail button:has-text("Track an issue")');
    assert.equal(await page.textContent('.va-list-title h1'), 'Tracked');
    assert.equal(await focusedId(), 'add-input');
  });

  await t.test('Enter tracks the remembered key', async () => {
    assert.equal(await page.inputValue('#add-input'), 'WEB-1423');
    await page.press('#add-input', 'Enter');
    await page.waitForSelector('[data-row="WEB-1423"]');
  });

  await t.test('Settings shows the saved connection', async () => {
    await page.click('.va-nav [data-view="settings"]');
    await page.waitForSelector('#set-token');
    assert.match(await page.getAttribute('#set-token', 'placeholder'), /saved/);
    assert.equal(await page.inputValue('#set-baseUrl'), url);
    assert.equal(await page.inputValue('#set-email'), 'e2e@example.com');
  });

  await t.test('the token is in the data file, readable only by you', async () => {
    await app.close();
    const saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.equal(saved.secrets.token, 'e2e-token');
    assert.equal(fs.statSync(dataFile).mode & 0o777, 0o600);
  });
});
