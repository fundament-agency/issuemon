'use strict';
/* End-to-end: starts the real Electron app against the mock Jira and walks through the main flows.
   Screenshots go to e2e/screenshots/.  Usage: npm run test:e2e */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');
const { createMockJira, seedDemo } = require('../test/support/mock-jira');
const { launchOptions } = require('./launch');
const { version: VERSION } = require('../package.json');

const SHOTS = path.join(__dirname, 'screenshots');

test('IssueMon end-to-end', { timeout: 180_000 }, async t => {
  const jira = createMockJira({ email: 'e2e@example.com', token: 'e2e-token' });
  seedDemo(jira);
  // Enough colleagues for the picker to get a search field
  for (const name of ['Casey Brooks', 'Dana Whitfield', 'Emery Quinn', 'Harper Nolan', 'Morgan Ellis', 'Taylor Reed']) {
    jira.users.push({ accountId: `acc-${name.split(' ')[0].toLowerCase()}`, displayName: name, accountType: 'atlassian', active: true });
  }
  const url = await jira.start();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'issuemon-e2e-'));
  const dataDir = path.join(userData, 'data'); // ISSUEMON_HOME: where the app keeps its own data file
  fs.mkdirSync(dataDir);
  const storeFile = path.join(dataDir, 'issuemon.json');
  fs.writeFileSync(storeFile, JSON.stringify({ settings: { baseUrl: url, email: 'e2e@example.com', defaultProject: 'WEB', excluded: ['Backlog'], language: 'en' } })); // English, whatever the Mac's language; no notes project, so new issues go into the default project
  fs.mkdirSync(SHOTS, { recursive: true });

  let app;
  t.after(async () => { // before the launch, so the mock Jira also stops when Electron fails to start
    await app?.close().catch(() => {}); // a failing sub-test must not leave Electron open until the timeout
    await jira.stop();
    fs.rmSync(userData, { recursive: true, force: true });
  });
  const env = { ...process.env, ISSUEMON_E2E: '1', ISSUEMON_USER_DATA: userData, ISSUEMON_HOME: dataDir, ISSUEMON_TOKEN: 'e2e-token', ISSUEMON_UPDATE_URL: `${url}/__releases/latest` };
  delete env.ELECTRON_RUN_AS_NODE; // set in terminals embedded in Electron-based tools; Electron then starts as plain Node
  app = await electron.launch(launchOptions(env));

  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1200, 780)); // CI displays are small: force the desktop layout. Content size: on Linux the window adds a title bar and menu bar
  await page.waitForFunction(() => window.innerWidth > 1100);
  // Diagnostics: show errors from renderer and main right away
  page.on('pageerror', err => console.error('[renderer-error]', err.message));
  page.on('console', msg => { if (msg.type() === 'error' || msg.type() === 'warning') console.error(`[renderer-${msg.type()}]`, msg.text()); });
  app.process().stderr?.on('data', d => { const line = String(d).trim(); if (line && !/Electron Helper|sandbox_extension|mach_port|shared_memory/.test(line)) console.error('[main]', line); });
  t.afterEach(async ctx => {
    if (ctx?.passed === false || ctx?.failed) await page.screenshot({ path: path.join(SHOTS, `error-${Date.now()}.png`) }).catch(() => {});
  });
  await page.emulateMedia({ colorScheme: null }); // otherwise Playwright always emulates light; the app decides itself
  const shot = name => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  const until = async (fn, what) => {
    for (let n = 0; n < 60; n++) {
      if (await fn()) return;
      await page.waitForTimeout(50);
    }
    throw new Error(`Waited too long: ${what}`);
  };
  const notes = () => app.evaluate(() => global.__issuemon.tracker.data.notes.map(n => ({ id: n.id, text: n.text, done: !!n.done })));
  const checkNow = async () => {
    await page.click('.va-sync [data-action="check"]');
    await page.waitForFunction(() => !document.querySelector('.va-sync .live.busy'));
  };
  await page.waitForSelector('.va-list-title h1');

  await t.test('starts connected in Changed', async () => {
    assert.equal(await page.textContent('.va-list-title h1'), 'Changed');
    await page.waitForSelector('.va-sync .live:not(.busy):not(.off)');
  });

  await t.test('macOS: no title bar, draggable sidebar, clickable buttons', { skip: process.platform !== 'darwin' }, async () => {
    assert.deepEqual(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getWindowButtonPosition()), { x: 18, y: 18 });
    const regions = await page.evaluate(() => {
      const region = sel => getComputedStyle(document.querySelector(sel)).getPropertyValue('-webkit-app-region') || getComputedStyle(document.querySelector(sel)).appRegion;
      return {
        platform: document.documentElement.classList.contains('platform-darwin'),
        side: region('.va-side'), nav: region('.va-nav button'), head: region('.va-list-head'),
        input: region('#add-input'), check: region('.va-sync [data-action="check"]'),
      };
    });
    assert.deepEqual(regions, { platform: true, side: 'drag', nav: 'no-drag', head: 'drag', input: 'no-drag', check: 'no-drag' });
    // No name next to the window buttons; the navigation starts below them
    assert.equal(await page.locator('.va-side').getByText('IssueMon').count(), 0);
    assert.ok((await page.locator('.va-nav button').first().boundingBox()).y >= 40);
  });

  // After Enter the field is empty and the preview shows nothing (even though the field still has focus).
  const assertAddCleared = async () => {
    assert.equal(await page.inputValue('#add-input'), '');
    assert.equal((await page.innerHTML('.add-preview')).trim(), '');
  };

  await t.test('tracking via URL and via a bare number', async () => {
    await page.fill('#add-input', 'https://example.atlassian.net/browse/WEB-1423');
    await page.waitForSelector('.ap.ok');
    assert.equal(await page.textContent('.ap.ok'), 'WEB-1423');
    await page.press('#add-input', 'Enter');
    await page.waitForSelector('[data-row="WEB-1423"]');
    assert.equal(await page.textContent('.va-list-title h1'), 'Tracked');
    await assertAddCleared();

    // A bare number gets the default project, also next to a full key
    await page.fill('#add-input', '1398 APP-88');
    await page.waitForFunction(() => document.querySelectorAll('.ap.ok').length === 2);
    assert.deepEqual(await page.locator('.ap.ok').allTextContents(), ['WEB-1398', 'APP-88']);
    await page.fill('#add-input', '');

    await page.fill('#add-input', '1398');
    await page.press('#add-input', 'Enter');
    await page.waitForSelector('[data-row="WEB-1398"]');
    await assertAddCleared();

    await page.fill('#add-input', 'APP-88 OPS-310 WEB-9999');
    await page.press('#add-input', 'Enter');
    await page.waitForSelector('[data-row="OPS-310"]');
    await page.waitForSelector('.snack.warn');
    assert.match(await page.textContent('#snacks'), /WEB-9999 not found/);
    assert.equal(await page.locator('.va-row').count(), 4);
    await assertAddCleared();
  });

  await t.test('detail shows metadata and relations; related keys select or offer Track', async t => {
    t.after(async () => {
      await app.evaluate(() => global.__issuemon.tracker.untrack('APP-52'));
      await page.waitForSelector('[data-row="APP-52"]', { state: 'detached' });
    });
    await page.click('[data-row="WEB-1423"]');
    assert.match(await page.textContent('.meta'), /Labels.*mobile.*checkout.*Fix version.*2026.10/s);
    assert.match(await page.textContent('[data-relations="parent"]'), /WEB-1398.*Search filter does not remember/);
    assert.match(await page.textContent('[data-relations="subtasks"]'), /1 of 2 done/);
    assert.match(await page.textContent('[data-relations="subtasks"]'), /WEB-1100.*Done/s);
    assert.match(await page.textContent('[data-relations="links"]'), /is blocked by.*OPS-310.*To Do/s);
    await shot('detail-relations');
    await app.evaluate(() => global.__issuemon.tracker.saveSettings({ language: 'nl' }));
    await page.waitForFunction(() => document.querySelector('[data-relations="parent"] h3')?.textContent === 'Bovenliggend issue');
    assert.match(await page.textContent('[data-relations="subtasks"]'), /1 van 2 afgerond/);
    await app.evaluate(() => global.__issuemon.tracker.saveSettings({ language: 'en' }));
    await page.waitForFunction(() => document.querySelector('[data-relations="parent"] h3')?.textContent === 'Parent');
    // Parent and sub-task keys share the same tracked selection path.
    await page.click('[data-relations="parent"] [data-key="WEB-1398"]');
    await page.waitForSelector('.va-row.sel[data-row="WEB-1398"]');
    assert.equal(await page.locator('.meta').getByText('Labels', { exact: true }).count(), 0);
    assert.equal(await page.locator('.meta').getByText('Fix version', { exact: true }).count(), 0);
    assert.equal(await page.locator('[data-relations]').count(), 0);
    await page.click('[data-row="WEB-1423"]');
    await page.click('[data-relations="subtasks"] [data-key="APP-88"]');
    await page.waitForSelector('.va-row.sel[data-row="APP-88"]');
    await page.click('[data-row="WEB-1423"]');
    await page.click('[data-relations="links"] [data-key="OPS-310"]');
    await page.waitForSelector('.va-row.sel[data-row="OPS-310"]');
    await page.click('[data-row="WEB-1423"]');
    await page.click('[data-relations="links"] [data-key="APP-52"]');
    assert.match(await page.textContent('#snacks'), /Track APP-52\?/);
    assert.equal(await page.locator('[data-row="APP-52"]').count(), 0);
    await page.locator('#snacks').getByRole('button', { name: 'Track', exact: true }).click();
    await page.waitForSelector('.va-row.sel[data-row="APP-52"]');
    assert.match(await page.textContent('.va-d-title'), /Crash when opening a deep link/);
    assert.ok(jira.requests.some(r => r.path.endsWith('/issue/bulkfetch') && ['parent', 'subtasks', 'issuelinks'].every(f => r.body.fields.includes(f))));
  });

  await t.test('detail escapes Jira metadata and handles partial relations', async t => {
    const text = '<img src=x onerror="window.relationInjected=true">';
    const issue = jira.addIssue({ key: 'TEST-33', summary: 'Partial relations', labels: [text], fixVersions: [text], parent: 'TEST-34', subtasks: ['TEST-34'],
      issuelinks: [{ type: { outward: text }, outwardIssue: 'TEST-34' }] });
    jira.addIssue({ key: 'TEST-34', summary: text, status: text });
    t.after(async () => {
      await app.evaluate(() => global.__issuemon.tracker.untrack('TEST-33'));
      jira.issues.delete('TEST-33');
      jira.issues.delete('TEST-34');
      await page.waitForSelector('[data-row="TEST-33"]', { state: 'detached' });
    });
    // One relation has only a key, as Jira may return with restricted access.
    issue.fields.subtasks = ['TEST-35'];
    await page.fill('#add-input', 'TEST-33');
    await page.press('#add-input', 'Enter');
    await page.waitForSelector('.va-row.sel[data-row="TEST-33"]');
    assert.match(await page.textContent('.meta'), /<img src=x/);
    assert.match(await page.textContent('[data-relations="parent"]'), /<img src=x/);
    assert.match(await page.textContent('[data-relations="links"]'), /<img src=x/);
    assert.match(await page.textContent('[data-relations="subtasks"]'), /0 of 1 done.*TEST-35.*—/s);
    assert.equal(await page.locator('.va-detail img').count(), 0);
    assert.equal(await page.evaluate(() => window.relationInjected), undefined);
    assert.equal(await page.locator('.va-detail').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await shot('detail-partial-relations');
  });

  await t.test('a newly tracked issue is selected and scrolled into view', async t => {
    const windowState = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      return { bounds: w.getBounds(), minimum: w.getMinimumSize() };
    });
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    t.after(async () => {
      // Restore the actual window state even when the scroll assertion fails.
      await app.evaluate(({ BrowserWindow }, saved) => {
        const w = BrowserWindow.getAllWindows()[0];
        w.setMinimumSize(...saved.minimum);
        w.setBounds(saved.bounds);
        global.__issuemon.tracker.untrack('WEB-1201');
      }, windowState);
      await page.evaluate(() => {
        window.__restoreRevealTest?.();
        delete window.__restoreRevealTest;
        delete window.__interruptedReveal;
      });
      await page.waitForFunction(({ width, height }) => innerWidth === width && innerHeight === height, viewport);
      await page.waitForSelector('[data-row="WEB-1201"]', { state: 'detached' });
    });
    // Short window: WEB-1201 is the least recently updated, so it is at the bottom and out of view
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setMinimumSize(380, 300); w.setContentSize(1200, 430); });
    await page.waitForFunction(() => window.innerWidth === 1200 && window.innerHeight === 430);
    await page.click('[data-row="WEB-1423"]');
    await page.waitForSelector('.va-row.sel[data-row="WEB-1423"]');
    await page.evaluate(() => {
      const original = Element.prototype.scrollIntoView;
      window.__restoreRevealTest = () => { Element.prototype.scrollIntoView = original; };
      Element.prototype.scrollIntoView = function (options) {
        original.call(this, options);
        if (this.dataset.row !== 'WEB-1201' || options?.behavior !== 'smooth') return;
        window.__restoreRevealTest();
        const list = this.closest('.va-rows');
        const row = this.getBoundingClientRect(), box = list.getBoundingClientRect();
        // Force the same full render as a state push, synchronously after starting
        // the real native animation. Synthetic clicks do not add pointer/focus input.
        document.querySelector('[data-action="help"]').click();
        document.querySelector('[data-action="help-close"]').click();
        window.__interruptedReveal = { outOfView: row.bottom > box.bottom + 1, replaced: !list.isConnected };
      };
    });
    await page.fill('#add-input', 'WEB-1201');
    await page.press('#add-input', 'Enter');
    await page.waitForSelector('.va-row.sel[data-row="WEB-1201"]');
    assert.equal(await page.locator('.va-row.sel').count(), 1);
    assert.match(await page.textContent('.va-d-title'), /Footer links to the old privacy policy/);
    // Scrolling is smooth, so wait until the row is fully inside the list
    const inView = () => page.evaluate(() => {
      const row = document.querySelector('.va-row.sel').getBoundingClientRect();
      const box = document.querySelector('.va-rows').getBoundingClientRect();
      return row.top >= box.top - 1 && row.bottom <= box.bottom + 1; // 1px margin for subpixel rounding
    });
    await until(inView, 'selected row in view');
    assert.deepEqual(await page.evaluate(() => window.__interruptedReveal), { outOfView: true, replaced: true });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    // Once revealed, manually scrolling away and re-rendering must not pin the row.
    await page.evaluate(() => {
      const list = document.querySelector('.va-rows');
      list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -500 }));
      list.scrollTo({ top: 0, behavior: 'instant' });
      document.querySelector('[data-action="help"]').click();
      document.querySelector('[data-action="help-close"]').click();
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('.va-row.sel[data-row="WEB-1201"]').count(), 1);
    assert.equal(await page.locator('.va-rows').evaluate(el => el.scrollTop), 0);
    assert.equal(await inView(), false);
  });

  await t.test('a real paste (clipboard and keyboard shortcut) tracks an issue, although the session denies permissions', async () => {
    await app.evaluate(({ clipboard }) => clipboard.writeText('WEB-1201'));
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('ControlOrMeta+V');
    await page.waitForSelector('.va-row.sel[data-row="WEB-1201"]');
    await page.click('.va-d [data-action="untrack"]'); // WEB-1201 does not belong here in the later tests
    await page.waitForSelector('[data-row="WEB-1201"]', { state: 'detached' });
  });

  await t.test('a change in Jira appears after a check, with a notification', async () => {
    jira.change('WEB-1423', { field: 'status', from: 'In Progress', to: 'Review', author: jira.people.alex });
    jira.comment('WEB-1423', 'Fix is on staging. Can you check on iOS Safari whether the card option is visible again?', jira.people.alex);
    jira.change('WEB-1423', { field: 'description', from: 'On mobile the card option is no longer in the list of payment methods.', to: 'On mobile the card option is no longer in the list of payment methods for amounts under 5 USD.', author: jira.people.alex });
    jira.change('APP-88', { field: 'priority', from: 'Medium', to: 'High', author: jira.people.jordan });
    jira.change('APP-88', { field: 'assignee', from: 'Jordan Lee', to: 'Demo User', author: jira.people.jordan });
    await checkNow();
    await page.click('[data-view="changed"]');
    await page.waitForSelector('.va-row.unread[data-row="WEB-1423"]');
    assert.equal(await page.locator('.va-row.unread').count(), 2);
    assert.equal(await page.textContent('.va-nav .count.hot'), '2');
    const notes = await app.evaluate(() => global.__issuemonNotifications);
    assert.deepEqual(notes.map(n => n.title).sort(), ['APP-88 was assigned to you', 'WEB-1423 · 3 changes']);
    // An assignment to you stands out: chip, row marker and a timeline that reads old → new
    assert.equal(await page.textContent('.va-row[data-row="APP-88"] .chip.me'), 'Assigned → you');
    assert.match(await page.getAttribute('.va-row[data-row="APP-88"]', 'class'), /\bmine\b/);
    assert.ok(!/\bmine\b/.test(await page.getAttribute('.va-row[data-row="WEB-1423"]', 'class')));
    assert.equal(await page.title(), 'IssueMon (2)');
    await page.click('[data-row="WEB-1423"]');
    await page.waitForSelector('.va-d blockquote');
    assert.match(await page.textContent('.va-d .va-desc'), /card payment option is missing from the list of payment methods/); // the description is below the actions
    // A description that grows: only the added part is highlighted, nothing struck through
    await page.waitForSelector('.va-d .diff.inline');
    assert.match(await page.textContent('.va-d .diff.inline ins'), /for amounts under 5 USD/);
    assert.equal(await page.locator('.va-d .diff.inline del').count(), 0);
    await shot('1-changed');
    await page.click('[data-row="APP-88"]');
    await page.waitForSelector('.va-d .tl .to.me');
    assert.match(await page.textContent('.va-d .tl'), /→ .*you/);
    // The tray menu shows the same changed issues, newest first
    const labels = await app.evaluate(() => global.__issuemon.trayLabels());
    assert.ok(labels.includes('Changed (2)'), labels.join(' | '));
    assert.ok(labels.some(l => l.startsWith('WEB-1423 · ')));
    assert.ok(labels.some(l => l.startsWith('APP-88 · ')));
    assert.ok(!labels.includes('No new changes'));
  });

  await t.test('own change: no notification, but visibly marked', async () => {
    const before = (await app.evaluate(() => global.__issuemonNotifications)).length;
    jira.comment('WEB-1398', 'Updated it myself.', jira.people.me);
    await checkNow();
    assert.equal((await app.evaluate(() => global.__issuemonNotifications)).length, before);
    await page.click('[data-view="tracked"]');
    await page.click('[data-row="WEB-1398"]');
    await page.waitForSelector('.va-d .own-tag');
    assert.match(await page.textContent('.va-d .own-tag'), /own change, not notified/);
    // Quiet rows show the latest activity, or who has it and when it was updated.
    assert.match(await page.textContent('.va-row[data-row="WEB-1398"] .va-row-sub'), /You commented/);
    assert.match(await page.textContent('.va-row[data-row="OPS-310"] .va-row-sub'), /Demo User \(you\)/);
    assert.ok(await page.$('.va-row[data-row="OPS-310"] .va-row-sub .va-time'), 'the update time sits on the right, like the time of a change');
  });

  await t.test('Jira unreachable: clear error and a quick retry', async () => {
    const port = new URL(url).port;
    await jira.stop();
    try {
      await page.click('[data-view="tracked"]');
      await checkNow();
      await page.waitForSelector('.va-list-head .banner.err');
      assert.match(await page.textContent('.va-list-head .banner.err'), /Check failed/);
      assert.equal(await page.locator('.va-list-head .banner.err [data-action="check"]').textContent(), 'Try again');
      await page.click('[data-row="OPS-310"]');
      await page.waitForSelector('.va-d .va-quiet');
      assert.match(await page.textContent('.va-d .va-quiet'), /Last check failed/);
      assert.match(await page.textContent('.va-sync'), /Next attempt/);
      await shot('12-offline');
    } finally {
      await jira.start(Number(port));
    }
    await page.click('.va-list-head .banner.err [data-action="check"]');
    await page.waitForSelector('.va-list-head .banner.err', { state: 'detached' });
    await page.waitForSelector('.va-sync .live:not(.busy):not(.off):not(.err)');
    assert.match(await page.textContent('.va-d .va-quiet'), /No new changes/);
  });

  await t.test('clicking a notification opens the changes of that issue', async () => {
    await page.click('[data-view="stale"]');
    await app.evaluate(() => global.__issuemon.openIssue('APP-88'));
    await page.waitForSelector('.va-row.sel[data-row="APP-88"]');
    assert.equal(await page.textContent('.va-list-title h1'), 'Changed');
    assert.match(await page.textContent('.va-d'), /changed priority/);
  });

  await t.test('process with E, then undo', async () => {
    await page.keyboard.press('e');
    await page.waitForSelector('[data-row="APP-88"]', { state: 'detached' });
    await page.waitForSelector('.va-row.sel[data-row="WEB-1423"]'); // jumps to the next issue
    await page.click('.snack.undoable button');
    await page.waitForSelector('[data-row="APP-88"]');
    await page.click('[data-row="APP-88"]');
    await page.click('.va-d [data-action="mark"]');
    await page.waitForSelector('[data-row="APP-88"]', { state: 'detached' });
    assert.equal(await app.evaluate(() => global.__issuemon.tracker.changedCount()), 1);
  });

  await t.test('inbox zero: the countdown is shown only once', async () => {
    await page.click('[data-view="changed"]');
    await page.click('.va-row[data-row]'); // the last open issue
    await page.keyboard.press('e');
    await page.waitForSelector('.va-row[data-row]', { state: 'detached' });
    await page.waitForSelector('.zero');
    // The header for the narrow window is in the DOM but hidden here: only visible ones count.
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('[data-next]')].filter(e => e.getClientRects().length).length), 1);
    const body = await page.evaluate(() => document.body.innerText);
    assert.equal(body.split('Next check').length - 1, 1);
    await page.click('.snack.undoable button'); // back to the state the next tests expect
    await page.waitForSelector('.va-row[data-row]');
    assert.equal(await app.evaluate(() => global.__issuemon.tracker.changedCount()), 1);
  });

  await t.test('shortcuts: ?, o and u', async () => {
    await page.keyboard.press('Escape');
    await page.keyboard.press('?');
    await page.waitForSelector('.help');
    assert.match(await page.textContent('.help'), /Shortcuts/);
    assert.match(await page.textContent('.help'), /Open in Jira/);
    // The modifier keys as the platform writes them: ⌘ and ⌥ on macOS, Ctrl and Alt elsewhere
    const [mod, alt] = process.platform === 'darwin' ? ['⌘', '⌥'] : ['Ctrl+', 'Alt+'];
    const keys = await page.locator('.help kbd').allTextContents();
    for (const key of [`${mod}K`, `${mod}R`, `${mod}Z`, `${alt}↑`]) assert.ok(keys.includes(key), `${key} in ${keys.join(' ')}`);
    assert.equal(await page.getAttribute('.va-sync [data-action="check"]', 'title'), `Check now (${mod}R)`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.help', { state: 'detached' });
    await page.click('[data-action="help"]');
    await page.waitForSelector('.help');
    await page.click('.help-backdrop', { position: { x: 5, y: 5 } });
    await page.waitForSelector('.help', { state: 'detached' });

    // o: open the selected issue in Jira
    await page.click('[data-view="changed"]');
    await page.click('[data-row="WEB-1423"]');
    await page.waitForSelector('.va-row.sel[data-row="WEB-1423"]');
    await page.keyboard.press('o');
    await until(async () => (await app.evaluate(() => global.__issuemonOpened || [])).at(-1) === `${url}/browse/WEB-1423`, 'open in Jira');

    // u: stop tracking, with an undo toast; ⌘Z brings it back
    await page.click('[data-view="tracked"]');
    await page.click('[data-row="WEB-1398"]');
    await page.waitForSelector('.va-row.sel[data-row="WEB-1398"]');
    await page.keyboard.press('u');
    await page.waitForSelector('[data-row="WEB-1398"]', { state: 'detached' });
    assert.match(await page.textContent('.snack.undoable'), /WEB-1398 is no longer tracked/);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await page.waitForSelector('[data-row="WEB-1398"]');
  });

  await t.test('stale list: only my old, open issues', async () => {
    await page.click('[data-view="stale"]');
    await page.waitForSelector('.va-row[data-row="WEB-1201"]');
    const keys = await page.locator('.va-row').evaluateAll(rows => rows.map(r => r.dataset.row));
    assert.deepEqual(keys, ['WEB-1201', 'APP-52', 'OPS-240']); // oldest at the top; Backlog (WEB-1050, excluded in the settings), finished issues and colleagues' issues drop out
    assert.equal(await page.textContent('.va-list-title h1'), 'Stale');
    assert.match(await page.textContent('.va-hint'), /3 issues assigned to you.*excluding Backlog/);
    assert.equal(await page.locator('.filter').count(), 0); // only you: no filter
    assert.match(await page.textContent('[data-action="stale-sort"]'), /Oldest first/);
    await shot('2-stale');
    // Sorting yourself: newest first, saved in the settings, and back again
    const order = () => page.locator('.va-row').evaluateAll(rows => rows.map(r => r.dataset.row).join());
    await page.click('[data-action="stale-sort"]');
    await until(async () => (await order()) === 'OPS-240,APP-52,WEB-1201', 'newest first');
    assert.match(await page.textContent('[data-action="stale-sort"]'), /Newest first/);
    await until(async () => (await app.evaluate(() => global.__issuemon.tracker.settings.staleSort)) === 'newest', 'sort order saved');
    await page.click('[data-action="stale-sort"]');
    await until(async () => (await order()) === 'WEB-1201,APP-52,OPS-240', 'oldest first');
    assert.match(await page.textContent('[data-action="stale-sort"]'), /Oldest first/);
    await page.click('[data-row="WEB-1201"]');
    // The latest activity is fetched on request: Priya's comment from the demo data
    await page.waitForSelector('.va-d .va-activity');
    assert.match(await page.textContent('.va-d .va-activity'), /Priya Patel.*commented.*Waiting for the legal check/s);
    // The age is shown once in the pane (the hero: "since <date>"), not again in a meta cell
    const detail = await page.textContent('.va-d');
    assert.match(await page.textContent('.va-stale-hero'), /days without activity\s*since /);
    assert.equal((detail.match(/updated/gi) || []).length, 0);
    await page.click('.va-d [data-action="track"]');
    await page.waitForSelector('.va-d .va-done');
  });

  await t.test('Tracked: done issues in a group, filtering and stopping tracking', async () => {
    await page.click('[data-view="tracked"]');
    await page.waitForSelector('[data-row="WEB-1201"]');
    assert.equal(await page.locator('#tracked-filter').count(), 0); // five tracked: no filter field yet
    const rows = () => page.locator('[data-row]').evaluateAll(rs => rs.map(r => r.dataset.row));
    const group = () => page.locator('.va-group');
    await page.fill('#add-input', 'WEB-1100 APP-40');
    await page.press('#add-input', 'Enter');
    await page.waitForSelector('.va-group');
    await page.waitForSelector('#tracked-filter'); // now seven tracked
    // The paste field and the filter field are exactly the same height
    const heights = await page.evaluate(() => [document.querySelector('.va-add .va-add-field'), document.querySelector('.va-filter')].map(el => el.getBoundingClientRect().height));
    assert.equal(heights[0], heights[1]);
    assert.match(await group().textContent(), /Done \(2\)/);
    // The done issue just added is selected, so the group is open and the row is there.
    await page.waitForSelector('[data-row="WEB-1100"]');
    await page.click('.va-group-toggle');
    await until(async () => !(await rows()).includes('WEB-1100'), 'group collapsed');
    assert.deepEqual((await rows()).filter(k => k === 'WEB-1100' || k === 'APP-40'), []); // collapsed: the rows are not in the list
    assert.equal(await page.textContent('.va-nav [data-view="tracked"] .count'), '7'); // the counter stays the total

    await page.click('.va-group-toggle');
    await page.waitForSelector('[data-row="WEB-1100"]');
    const open = await rows();
    assert.equal(open.length, 7);
    assert.deepEqual(open.slice(-2), ['WEB-1100', 'APP-40']); // below all active rows, most recently updated first
    await shot('14-tracked-done');

    // Filtering: the group expands and shows only what matches
    await page.fill('#tracked-filter', 'camp');
    await until(async () => (await rows()).length === 1, 'filter on camp');
    assert.deepEqual(await rows(), ['WEB-1100']);
    assert.match(await group().textContent(), /Done \(1\)/);
    await page.press('#tracked-filter', 'Escape');
    await until(async () => (await rows()).length === 7, 'filter cleared with Esc');
    assert.equal(await page.inputValue('#tracked-filter'), '');
    // Focus has left the (replaced) filter field: j moves the selection instead of typing.
    const selBefore = await page.getAttribute('.va-row.sel', 'data-row');
    await page.keyboard.press('j');
    await until(async () => (await page.getAttribute('.va-row.sel', 'data-row')) !== selBefore, 'j after Esc moves the selection');
    assert.equal(await page.inputValue('#tracked-filter'), '');
    await page.fill('#tracked-filter', 'rivera'); // name of the assignee
    await until(async () => (await rows()).includes('WEB-1423'), 'filter on rivera');
    assert.equal(await group().count(), 0);
    await page.fill('#tracked-filter', 'doesnotexist');
    await page.waitForSelector('.va-empty-list');
    assert.match(await page.textContent('.va-empty-list'), /Nothing found for 'doesnotexist'\./);
    assert.equal(await page.textContent('.va-nav [data-view="tracked"] .count'), '7');
    await page.fill('#tracked-filter', '');
    await until(async () => (await rows()).length === 7, 'filter empty');

    // Stop all: one toast, and it brings both back
    await page.click('[data-action="untrack-done"]');
    await until(async () => (await rows()).length === 5, 'both done issues gone');
    await page.waitForSelector('.snack.undoable');
    assert.match(await page.textContent('.snack.undoable'), /2 issues are no longer tracked/);
    await page.click('.snack.undoable button');
    await page.waitForSelector('.va-group');
    assert.match(await group().textContent(), /Done \(2\)/);

    // Stop per row, so the tracked set is unchanged for the last test
    for (const key of ['WEB-1100', 'APP-40']) {
      await page.hover(`[data-row="${key}"]`);
      await page.click(`[data-row="${key}"] [data-action="untrack"]`);
      await page.waitForSelector(`[data-row="${key}"]`, { state: 'detached' });
    }
    assert.equal(await group().count(), 0);
    assert.equal(await page.locator('#tracked-filter').count(), 0); // five again: the filter field disappears
    assert.equal(await page.textContent('.va-nav [data-view="tracked"] .count'), '5');
  });

  await t.test('a tracked issue that is deleted or out of reach is reported once, and processing keeps the red row', async () => {
    const notifications = () => app.evaluate(() => global.__issuemonNotifications);
    const before = (await notifications()).length;
    const changed = () => app.evaluate(() => global.__issuemon.tracker.changedCount());
    jira.remove('WEB-1201');
    await checkNow();
    await page.click('[data-view="changed"]');
    await page.waitForSelector('[data-row="WEB-1201"]');
    assert.equal(await changed(), 2);
    assert.deepEqual((await notifications()).slice(before).map(n => [n.title, n.body]), [['WEB-1201 changed', 'No longer accessible (deleted, or you no longer have access)']]);
    await page.click('[data-row="WEB-1201"]');
    await page.waitForSelector('.va-d .tl');
    assert.match(await page.textContent('.va-d .tl'), /No longer accessible \(deleted, or you no longer have access\)/);
    assert.match(await page.textContent('.va-d .banner.err'), /Not found, or no longer accessible/);
    await shot('15-gone');

    // Processed: out of Changed, still in Tracked with the error until you stop tracking it
    await page.click('.va-d [data-action="mark"]');
    await page.waitForSelector('[data-row="WEB-1201"]', { state: 'detached' });
    assert.equal(await changed(), 1);
    await page.click('[data-view="tracked"]');
    await page.waitForSelector('.va-row.err[data-row="WEB-1201"]');
    assert.match(await page.textContent('.va-row.err[data-row="WEB-1201"]'), /Not found, or no longer accessible/);

    // Still missing at the next check: nothing new
    await checkNow();
    assert.equal(await changed(), 1);
    assert.equal((await notifications()).length, before + 1);

    // Access comes back: the red row goes, without a notification
    jira.restore('WEB-1201');
    await checkNow();
    await page.waitForSelector('.va-row.err[data-row="WEB-1201"]', { state: 'detached' });
    await page.waitForSelector('[data-row="WEB-1201"]');
    assert.equal(await changed(), 1);
    assert.equal((await notifications()).length, before + 1);
  });

  await t.test('notes: add, edit, remove and turn one into an issue', async () => {
    await page.click('[data-view="notes"]');
    await page.waitForSelector('#note-input:focus');
    assert.equal(await page.textContent('.va-page h1'), 'Notes');
    assert.match(await page.textContent('.va-notes .va-hint'), /choose the title, project and type; the issue goes into the backlog/);
    await page.fill('#note-input', 'Cookie banner covers the footer');
    await page.press('#note-input', 'Enter');
    await page.waitForSelector('.note');
    await page.fill('#note-input', 'Typo on the contact page'); // field stays focused
    await page.press('#note-input', 'Enter');
    await page.waitForFunction(() => document.querySelectorAll('.note').length === 2);
    assert.equal(await page.inputValue('#note-input'), '');
    assert.equal(await page.textContent('.va-nav [data-view="notes"] .count'), '2');
    const [typo, cookie] = await notes(); // newest at the top

    // Editing: Enter saves, Esc restores the old text
    await page.fill(`#note-${cookie.id}`, 'Cookie banner covers the footer on mobile');
    await page.press(`#note-${cookie.id}`, 'Enter');
    await until(async () => (await notes())[1].text === 'Cookie banner covers the footer on mobile', 'note saved');
    await page.fill(`#note-${cookie.id}`, 'discard this');
    await page.press(`#note-${cookie.id}`, 'Escape');
    assert.equal(await page.inputValue(`#note-${cookie.id}`), 'Cookie banner covers the footer on mobile');
    assert.equal((await notes())[1].text, 'Cookie banner covers the footer on mobile');

    // A long note wraps over several lines (no "…") and "Create issue" is always visible
    const long = 'The cookie banner covers the footer on mobile and blocks the Checkout button, so customers cannot complete their order. This only happens on iOS Safari, not on Android.';
    await page.fill('#note-input', long);
    await page.press('#note-input', 'Enter');
    await page.waitForFunction(() => document.querySelectorAll('.note').length === 3);
    const [wide] = await notes(); // newest at the top
    assert.equal(wide.text, long);
    assert.equal(await page.inputValue(`#note-${wide.id}`), long);
    const lineHeight = await page.evaluate(id => parseFloat(getComputedStyle(document.getElementById(id)).lineHeight), `note-${wide.id}`);
    assert.ok(await page.evaluate(id => document.getElementById(id).clientHeight, `note-${wide.id}`) >= 2 * lineHeight, 'long note spans several lines');
    assert.equal(await page.evaluate(id => document.getElementById(id).scrollHeight <= document.getElementById(id).clientHeight, `note-${wide.id}`), true, 'nothing truncated');
    const makeOpacity = id => page.evaluate(id => getComputedStyle(document.querySelector(`[data-action="note-issue"][data-id="${id}"]`)).opacity, id);
    await page.hover('#note-input');
    assert.equal(await makeOpacity(wide.id), '1', 'Create issue is visible without hover');
    await page.click(`[data-action="note-remove"][data-id="${wide.id}"]`);
    await page.waitForSelector(`#note-${wide.id}`, { state: 'detached' });
    assert.equal(await page.locator('.note').count(), 2);

    // Remove and undo
    await page.click(`[data-action="note-remove"][data-id="${typo.id}"]`);
    await page.waitForSelector(`#note-${typo.id}`, { state: 'detached' });
    await page.click('.snack.undoable button');
    await page.waitForSelector(`#note-${typo.id}`);

    // Ticking off: struck through, not counted and can no longer become an issue; then turned back on
    await page.check(`#note-done-${typo.id}`);
    await page.waitForSelector(`.note.done #note-${typo.id}`);
    assert.equal(await page.evaluate(id => getComputedStyle(document.getElementById(id)).textDecorationLine, `note-${typo.id}`), 'line-through');
    assert.equal(await page.textContent('.va-nav [data-view="notes"] .count'), '1');
    assert.equal(await page.locator(`[data-action="note-issue"][data-id="${typo.id}"]`).count(), 0);
    await until(async () => (await notes())[0].done, 'ticked off saved');
    // Alignment: time and bin of an open and a ticked-off note share the same right edge
    const rightEdge = (id, part) => page.evaluate(([id, part]) => {
      const r = document.querySelector(`.note:has(#note-${id}) ${part}`)?.getBoundingClientRect();
      return r ? r.right : null;
    }, [id, part]);
    for (const part of ['.note-time', '[data-action="note-remove"]']) {
      await until(async () => {
        const [a, b] = [await rightEdge(typo.id, part), await rightEdge(cookie.id, part)];
        return a !== null && b !== null && Math.abs(a - b) <= 1;
      }, `${part}: right edge matches in open and ticked-off row`);
    }
    await page.uncheck(`#note-done-${typo.id}`);
    await page.waitForSelector(`.note:not(.done) #note-${typo.id}`);
    await until(async () => !(await notes())[0].done, 'turned back on');
    assert.equal(await page.textContent('.va-nav [data-view="notes"] .count'), '2');

    // Order: dragging by the grip, and ⌥↑ / ⌥↓ in the text field
    const order = async () => (await notes()).map(n => n.id);
    const box = async selector => { // the list re-renders after every change: wait until the element is back and laid out
      const loc = page.locator(selector);
      await loc.waitFor({ state: 'visible' });
      let b = null;
      await until(async () => (b = await loc.boundingBox()) !== null, `${selector} laid out`);
      return b;
    };
    await page.hover(`#note-${typo.id}`);
    const grip = await box(`#note-grip-${typo.id}`);
    const below = await box(`#note-${cookie.id}`);
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    try {
      await page.mouse.move(grip.x + grip.width / 2, below.y + below.height, { steps: 6 });
    } finally {
      await page.mouse.up(); // never leave the button down: every later test would be stuck in a drag
    }
    await until(async () => (await order()).join() === [cookie.id, typo.id].join(), 'dragged down');
    await page.focus(`#note-${typo.id}`);
    await page.keyboard.press('Alt+ArrowUp');
    await until(async () => (await order()).join() === [typo.id, cookie.id].join(), '⌥↑');
    assert.equal(await page.evaluate(() => document.activeElement.id), `note-${typo.id}`); // focus stays on the note
    await page.keyboard.press('Alt+ArrowDown');
    await until(async () => (await order()).join() === [cookie.id, typo.id].join(), '⌥↓');
    await page.keyboard.press('Alt+ArrowUp');
    await until(async () => (await order()).join() === [typo.id, cookie.id].join(), 'back at the top');
    await page.keyboard.press('Escape');

    await page.check(`#note-done-${typo.id}`); // ticked off in the screenshot
    await page.waitForSelector(`.note.done #note-${typo.id}`);
    const created = () => jira.requests.filter(q => q.method === 'POST' && q.path === '/rest/api/3/issue');

    // Create issue: first a panel below the note; nothing goes to Jira until you click Create
    await page.click(`[data-action="note-issue"][data-id="${cookie.id}"]`);
    await page.waitForSelector('#draft-summary');
    assert.equal(await page.inputValue('#draft-summary'), 'Cookie banner covers the footer on mobile');
    assert.equal(await page.inputValue('#draft-project'), 'WEB'); // the default project: there is no notes project
    await page.waitForSelector('#draft-type:not([disabled])');
    assert.deepEqual(await page.locator('#draft-type option').allTextContents(), ['Story', 'Task', 'Bug']);
    assert.equal(await page.locator('#draft-type option:checked').textContent(), 'Task');
    assert.match(await page.textContent('[data-draft] .va-hint'), /The issue goes into the backlog of WEB/);
    await shot('9-notes');

    // Cancel: panel gone, nothing created
    await page.click('[data-action="draft-cancel"]');
    await page.waitForSelector('[data-draft]', { state: 'detached' });
    assert.equal(created().length, 0);

    // Open again, change title and type and create: the note disappears and the issue is tracked
    await page.click(`[data-action="note-issue"][data-id="${cookie.id}"]`);
    await page.waitForSelector('#draft-type:not([disabled])');
    // An unknown project gives an error in the panel; note and panel stay
    await page.fill('#draft-project', 'nope');
    assert.equal(await page.inputValue('#draft-project'), 'NOPE');
    await page.press('#draft-project', 'Enter');
    await page.waitForSelector('#draft-error:has-text("Project NOPE does not exist")');
    assert.equal(await page.locator(`#note-${cookie.id}`).count(), 1);
    await page.fill('#draft-project', 'ops');
    await page.press('#draft-project', 'Tab');
    await page.waitForFunction(() => document.querySelector('#draft-type option:checked')?.textContent === 'Task');
    await page.focus('#draft-summary');
    await page.keyboard.press('End');
    await page.keyboard.type(' (mobile)');
    await page.selectOption('#draft-type', { label: 'Bug' });
    await page.click('[data-action="draft-create"]');
    await page.waitForSelector(`#note-${cookie.id}`, { state: 'detached' });
    await page.waitForSelector('[data-draft]', { state: 'detached' });
    await page.waitForSelector('.snack.ok:has-text("OPS-311 created and now tracked")');
    assert.equal(created().length, 1);
    assert.equal(jira.issues.get('OPS-311').fields.type, 'Bug');
    assert.equal(jira.issues.get('OPS-311').fields.summary, 'Cookie banner covers the footer on mobile (mobile)');
    assert.deepEqual((await notes()).map(n => n.text), ['Typo on the contact page']);
    // "View" is not an undo: ⌘Z (outside a field) therefore does not navigate and leaves the toast in place.
    assert.equal(await page.locator('.snack:has-text("created") button').evaluate(b => b.parentElement.classList.contains('undoable')), false);
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(150);
    assert.equal(await page.locator('[data-note-input]').count(), 1); // still in Notes
    assert.equal(await page.locator('.snack:has-text("created")').count(), 1);
    await page.click('.snack:has-text("created") button'); // View
    await page.waitForSelector('.va-row.sel[data-row="OPS-311"]');
    assert.equal(await page.textContent('.va-list-title h1'), 'Tracked');
    assert.match(await page.textContent('.va-d-title'), /Cookie banner covers the footer on mobile \(mobile\)/);
  });

  await t.test('settings: changing the stale threshold', async () => {
    await page.click('[data-view="settings"]');
    await page.waitForSelector('#set-staleDays');
    assert.equal(await page.inputValue('#set-baseUrl'), url);
    assert.match(await page.getAttribute('#set-token', 'placeholder'), /saved/);
    assert.equal(await page.inputValue('#set-notesProject'), ''); // empty: the default project is used
    assert.equal(await page.getAttribute('#set-notesProject', 'placeholder'), 'e.g. OPS');
    assert.equal(await page.getAttribute('#set-excluded', 'placeholder'), 'e.g. Backlog, On hold');
    assert.equal(await page.getAttribute('#set-excludedProjects', 'placeholder'), 'e.g. ARCHIVE-*, Sandbox');
    await page.fill('#set-staleDays', '20');
    await page.press('#set-staleDays', 'Tab');
    await page.waitForFunction(() => document.querySelector('.va-nav [data-view="stale"] .count')?.textContent === '2');
    const staleCount = n => page.waitForFunction(c => document.querySelector('.va-nav [data-view="stale"] .count')?.textContent === c, String(n));
    // Backlog is just a status: removing it → WEB-1050 (70 days) is added; then back again
    assert.equal(await page.inputValue('#set-excluded'), 'Backlog');
    await page.fill('#set-excluded', '');
    await page.press('#set-excluded', 'Tab');
    await staleCount(3);
    await page.fill('#set-excluded', 'Backlog');
    await page.press('#set-excluded', 'Tab');
    await staleCount(2);
    // Excluding project APP or OPS, by name or key → APP-52 drops out; then nothing again (the default)
    assert.equal(await page.inputValue('#set-excludedProjects'), '');
    await page.fill('#set-excludedProjects', 'ARCHIVE-*, app, ops');
    await page.press('#set-excludedProjects', 'Tab');
    await staleCount(1);
    assert.equal(await page.inputValue('#set-excludedProjects'), 'ARCHIVE-*, app, ops'); // as typed
    await page.fill('#set-excludedProjects', '');
    await page.press('#set-excludedProjects', 'Tab');
    await staleCount(2);
    // Half-typed text survives a state update in the background
    await page.fill('#set-email', 'half-typed@');
    await app.evaluate(() => global.__issuemon.tracker.changed());
    await page.waitForTimeout(150);
    assert.equal(await page.inputValue('#set-email'), 'half-typed@');
    await page.fill('#set-email', 'e2e@example.com');
    await page.keyboard.press('Tab');

    await page.click('[data-action="test-conn"]');
    const conn = '.set-row:has([data-action="test-conn"]) .conn.ok';
    await page.waitForSelector(conn);
    assert.match(await page.textContent(conn), /Connected as Demo User/);

    await page.click('[data-action="test-notify"]');
    const note = '.set-row:has([data-action="test-notify"]) .conn.ok';
    await page.waitForSelector(note);
    assert.match(await page.textContent(note), /Last notification shown/);
    const notes = await app.evaluate(() => global.__issuemonNotifications);
    assert.equal(notes.at(-1).title, 'Test notification from IssueMon');
    await shot('3-settings');
  });

  await t.test('stale: ticking colleagues and filtering by person', async () => {
    const rows = () => page.locator('.va-row').evaluateAll(els => els.map(r => r.dataset.row));
    const staleCount = n => page.waitForFunction(c => document.querySelector('.va-nav [data-view="stale"] .count')?.textContent === c, String(n));
    await page.click('[data-view="settings"]');
    await page.waitForSelector('.people .person');
    const names = await page.locator('.people .person').evaluateAll(els => els.map(e => e.querySelector('span:not(.avatar)').textContent.trim()));
    assert.equal(names[0], 'Demo User (you)'); // you at the top, the rest by name, without the app and the former colleague
    assert.deepEqual(names.slice(1, 4), ['Alex Morgan', 'Casey Brooks', 'Dana Whitfield']);
    assert.equal(names.length, 11);
    assert.ok(await page.isChecked('#person-acc-me'));
    assert.ok(await page.isDisabled('#person-acc-me')); // the last ticked one stays ticked

    // Searching the list
    await page.fill('#people-q', 'riv');
    await until(async () => (await page.locator('.people .person').count()) === 1, 'search result');
    await page.click('#person-acc-sam');
    await page.fill('#people-q', '');
    await page.click('#person-acc-alex');
    await staleCount(4); // you 2 (threshold is 20 days), Sam 1, Alex 1 (OPS-199 is only 9 days)
    assert.ok(!(await page.isDisabled('#person-acc-me')));
    // The chosen people are chips above the list; × removes one
    const chips = () => page.locator('.pchip .pchip-n').allTextContents();
    assert.deepEqual(await chips(), ['You', 'Alex Morgan', 'Sam Rivera']);
    await page.click('.pchip-x[data-id="acc-alex"]');
    await until(async () => !(await page.isChecked('#person-acc-alex')), 'Alex removed via his chip');
    assert.deepEqual(await chips(), ['You', 'Sam Rivera']);
    await staleCount(3);
    await page.click('#person-acc-alex');
    await staleCount(4);
    assert.deepEqual(await chips(), ['You', 'Alex Morgan', 'Sam Rivera']);
    await page.locator('.fld:has(.people)').screenshot({ path: path.join(SHOTS, '11-stale-people.png') });
    const saved = await app.evaluate(() => global.__issuemon.tracker.settings.stalePeople.map(p => p.accountId));
    assert.deepEqual(saved, ['acc-me', 'acc-sam', 'acc-alex']);

    await page.click('[data-view="stale"]');
    await page.waitForSelector('.filter');
    assert.deepEqual(await rows(), ['WEB-1201', 'WEB-1150', 'APP-61', 'APP-52']);
    assert.match(await page.textContent('.va-hint'), /4 issues assigned to 3 people/);
    assert.equal((await page.textContent('#stale-menu')).trim(), 'Everyone');
    assert.match(await page.textContent('.va-row[data-row="WEB-1150"] .va-row-sub'), /Sam Rivera/);

    const menuOpen = async () => (await page.locator('.fmenu').count()) === 1;
    await page.click('#stale-menu');
    // Playwright clicks bypass the macOS drag regions; so check here that nothing under the menu is draggable.
    if (process.platform === 'darwin') assert.equal(await page.$eval('.va-hint', el => getComputedStyle(el).webkitAppRegion), 'no-drag');
    const items = await page.locator('.fitem').evaluateAll(els => els.map(e => e.textContent.trim().replace(/\s+/g, ' ')));
    assert.deepEqual(items, ['Everyone4', 'DUYou2', 'AMAlex Morgan1', 'SRSam Rivera1']);
    await page.click('.fitem[data-id="acc-sam"]');
    await until(async () => (await rows()).join() === 'WEB-1150', 'filter on Sam');
    assert.match(await page.textContent('.va-hint'), /1 issue assigned to Sam Rivera/);
    assert.match(await page.textContent('#stale-menu'), /Sam/);
    await staleCount(4); // the sidebar counts all stale issues, even when the list is filtered to one person
    await page.click('.fitem[data-id="acc-alex"]'); // the menu stays open to tick more people
    await until(async () => (await rows()).join() === 'WEB-1150,APP-61', 'filter on Sam and Alex');
    assert.match(await page.textContent('.va-hint'), /2 issues assigned to Alex Morgan and Sam Rivera/);
    await shot('10-stale-filter');
    await page.click('.fitem[data-id="acc-me"]'); // everyone chosen = no filter
    await until(async () => (await rows()).length === 4, 'all three');
    assert.equal(await page.getAttribute('#sf-all', 'aria-pressed'), 'true');
    await page.click('.fitem[data-id="acc-alex"]');
    await until(async () => (await rows()).join() === 'APP-61', 'filter on Alex');
    await until(async () => JSON.stringify(JSON.parse(fs.readFileSync(storeFile, 'utf8')).settings.staleFilter) === '["acc-alex"]', 'filter in the store'); // survives a restart
    await page.keyboard.press('Escape');
    await until(async () => !(await menuOpen()), 'Esc closes the menu');
    await page.click('#stale-menu');
    await page.click('.va-rows', { position: { x: 100, y: 300 } }); // empty list below the menu
    await until(async () => !(await menuOpen()), 'clicking beside it closes the menu');
    await page.click('#stale-menu');
    await page.click('#sf-all');
    await until(async () => (await rows()).length === 4, 'everyone');
    assert.ok(!(await menuOpen())); // Everyone is a reset and closes the menu
  });

  await t.test('stale: Unassigned as a group of its own', async () => {
    const rows = () => page.locator('.va-row').evaluateAll(els => els.map(r => r.dataset.row));
    const staleCount = n => page.waitForFunction(c => document.querySelector('.va-nav [data-view="stale"] .count')?.textContent === c, String(n));
    const chips = () => page.locator('.pchip .pchip-n').allTextContents();
    await page.click('[data-view="settings"]');
    await page.waitForSelector('#person-unassigned');
    assert.ok(!(await page.isChecked('#person-unassigned'))); // off by default
    await page.click('#person-unassigned');
    await staleCount(5); // WEB-1312 has no assignee; OPS-275 neither, but it is only 5 days old
    assert.deepEqual(await chips(), ['You', 'Alex Morgan', 'Sam Rivera', 'Unassigned']);
    await until(async () => (await app.evaluate(() => global.__issuemon.tracker.settings.staleUnassigned)) === true, 'setting saved');
    await page.locator('.fld:has(.people)').screenshot({ path: path.join(SHOTS, '15-stale-unassigned-setting.png') });

    await page.click('[data-view="stale"]');
    await page.waitForSelector('.filter');
    assert.deepEqual(await rows(), ['WEB-1201', 'WEB-1150', 'WEB-1312', 'APP-61', 'APP-52']);
    assert.match(await page.textContent('.va-hint'), /5 issues assigned to 3 people or unassigned/);
    assert.match(await page.textContent('.va-row[data-row="WEB-1312"] .va-row-sub'), /Unassigned/);
    await page.click('#stale-menu');
    const items = await page.locator('.fitem').evaluateAll(els => els.map(e => e.textContent.trim().replace(/\s+/g, ' ')));
    assert.deepEqual(items, ['Everyone5', 'DUYou2', 'AMAlex Morgan1', 'SRSam Rivera1', '–Unassigned1']);
    await page.click('.fitem[data-id="unassigned"]');
    await until(async () => (await rows()).join() === 'WEB-1312', 'filter on Unassigned');
    assert.match(await page.textContent('.va-hint'), /1 issue without an assignee/);
    assert.match(await page.textContent('#stale-menu'), /Unassigned/);
    await shot('16-stale-unassigned');
    await page.click('.fitem[data-id="acc-sam"]');
    await until(async () => (await rows()).join() === 'WEB-1150,WEB-1312', 'filter on Sam and Unassigned');
    assert.match(await page.textContent('.va-hint'), /2 issues assigned to Sam Rivera or unassigned/);
    await page.keyboard.press('Escape');

    // Unticked again: the issues go, and the group no longer counts in the filter
    await page.click('[data-view="settings"]');
    await page.click('.pchip-x[data-id="unassigned"]'); // via its chip
    await staleCount(4);
    await until(async () => !(await page.isChecked('#person-unassigned')), 'Unassigned unticked');
    await page.click('[data-view="stale"]');
    await until(async () => (await rows()).join() === 'WEB-1150', 'only Sam left in the filter');
    await page.click('#stale-menu');
    await page.click('#sf-all');
    await until(async () => (await rows()).length === 4, 'everyone');
  });

  await t.test('an edited comment appears in Changed, with a notification', async () => {
    const before = (await app.evaluate(() => global.__issuemonNotifications)).length;
    const id = jira.issues.get('WEB-1201').comments[0].id; // Priya's comment from the demo data, older than the tracking
    jira.editComment('WEB-1201', id, 'Legal approved the text, can ship.', jira.people.priya);
    await checkNow();
    await page.click('[data-view="changed"]');
    await page.waitForSelector('.va-row.unread[data-row="WEB-1201"]');
    assert.equal(await page.textContent('.va-row[data-row="WEB-1201"] .chip'), '1 comment edited');
    const notes = await app.evaluate(() => global.__issuemonNotifications);
    assert.deepEqual(notes.slice(before).map(n => [n.title, n.body]), [['WEB-1201 changed', 'Priya Patel edited a comment: “Legal approved the text, can ship.”']]);
    await page.click('[data-row="WEB-1201"]');
    await page.waitForSelector('.va-d .tl blockquote');
    assert.match(await page.textContent('.va-d .tl'), /Priya Patel edited a comment.*Legal approved the text, can ship\./s);

    // A second edit: IssueMon now knows the old text, so the timeline marks what changed
    jira.editComment('WEB-1201', id, 'Legal approved the text, ship it on Monday.', jira.people.priya);
    await checkNow();
    await page.waitForSelector('.va-d .tl .diff');
    assert.match((await page.locator('.va-d .tl .diff ins').allTextContents()).join(' '), /Monday/);
    assert.equal(await page.textContent('.va-row[data-row="WEB-1201"] .chip'), '1 comment edited'); // one comment, edited twice
    await shot('17-comment-edited');
    await page.click('.va-d [data-action="mark"]');
    await page.waitForSelector('[data-row="WEB-1201"]', { state: 'detached' });
  });

  await t.test('new and edited comment mentions highlight actual nodes, escape text and notify', async () => {
    const { me, sam } = jira.people;
    const row = '.va-row[data-row="WEB-1201"]';
    const pending = '.va-d .tl-i:not(.done)';
    const before = (await app.evaluate(() => global.__issuemonNotifications)).length;
    const at = Date.now();
    const issue = jira.comment('WEB-1201', '@Demo User is plain text. <img src=x onerror=alert(1)> Please review', sam, at, [
      { ...me, accountId: 'another-account' }, me,
    ]);
    const id = issue.comments.at(-1).id;
    await checkNow();
    await page.click('[data-view="changed"]');
    await page.waitForSelector(`${row}.mine .chip.me`);
    assert.equal(await page.textContent(`${row} .chip.me`), 'Mentions you');
    await page.click(row);
    await page.waitForSelector(`${pending} .mention-me`);
    assert.deepEqual(await page.locator(`${pending} .mention-me`).allTextContents(), ['@Demo User']);
    assert.equal(await page.locator(`${pending} img`).count(), 0);
    assert.match(await page.textContent(pending), /<img src=x onerror=alert\(1\)>/);
    let notes = await app.evaluate(() => global.__issuemonNotifications);
    assert.deepEqual(notes.slice(before).map(n => n.body), ['Sam Rivera mentioned you on WEB-1201']);
    await shot('20-comment-mentions');
    await page.click('.va-d [data-action="mark"]');
    await page.waitForSelector(row, { state: 'detached' });

    // An edit keeps the word diff while highlighting the real mention, even hostile mention text.
    const hostile = { ...me, displayName: '<b>Demo</b>' };
    jira.editComment('WEB-1201', id, 'Ready for review', sam, at + 1000, [hostile]);
    await checkNow();
    await page.waitForSelector(`${row}.mine .chip.me`);
    await page.click(row);
    await page.waitForSelector(`${pending} .diff .mention-me`);
    assert.equal(await page.textContent(`${pending} .mention-me`), '@<b>Demo</b>');
    assert.equal(await page.locator(`${pending} .mention-me b`).count(), 0);
    notes = await app.evaluate(() => global.__issuemonNotifications);
    assert.equal(notes.at(-1).body, 'Sam Rivera mentioned you on WEB-1201');
    await shot('20-comment-mention-edited');
    await page.click('.va-d [data-action="mark"]');
    await page.waitForSelector(row, { state: 'detached' });

    jira.editComment('WEB-1201', id, 'Ready for review', sam, at + 2000, [{ ...hostile, accountId: 'another-account' }]);
    await checkNow();
    await page.waitForSelector(row);
    assert.equal(await page.locator(`${row}.mine`).count(), 0);
    assert.equal(await page.locator(`${row} .chip.me`).count(), 0);
    await page.click(row);
    assert.equal(await page.locator(`${pending} .mention-me`).count(), 0);
    notes = await app.evaluate(() => global.__issuemonNotifications);
    assert.match(notes.at(-1).body, /edited a comment/);
    await page.click('.va-d [data-action="mark"]');
    await page.waitForSelector(row, { state: 'detached' });
  });

  await t.test('notifications lead with assignments and summarize actionable issue counts', async t => {
    const { me, sam } = jira.people;
    const keys = ['RANK-1', 'RANK-2', 'RANK-3', 'RANK-4'];
    t.after(async () => {
      await app.evaluate((_, keys) => {
        for (const key of keys) global.__issuemon.tracker.untrack(key);
      }, keys);
      for (const key of keys) jira.issues.delete(key);
    });
    const at = Date.now();
    for (const key of keys) jira.addIssue({ key, summary: `Notification ranking ${key}`, updated: at - 60_000 });
    await page.fill('#add-input', keys.join(' '));
    await page.press('#add-input', 'Enter');
    await until(async () => app.evaluate(() => global.__issuemon.tracker.data.tracked.filter(t => t.key.startsWith('RANK-') && t.issue).length === 4), 'ranking issues tracked');
    const notifications = () => app.evaluate(() => global.__issuemonNotifications);
    let before = (await notifications()).length;
    jira.change('RANK-4', { field: 'assignee', to: me.displayName, author: sam, at });
    jira.comment('RANK-4', 'Handing this over, I am on holiday from tomorrow.', sam, at + 1000);
    await checkNow();
    await until(async () => (await notifications()).length > before, 'ranked notification recorded');
    assert.deepEqual((await notifications()).slice(before).map(n => [n.title, n.body, n.key]), [
      ['RANK-4 was assigned to you', 'Sam Rivera · Assigned to you', 'RANK-4'],
    ]);
    await page.click('[data-view="changed"]');
    await page.waitForSelector('.va-row[data-row="RANK-4"] .chip.me');
    await page.click('.va-row[data-row="RANK-4"]');
    await shot('22-assignment-before-comment');

    // The old assignment remains pending, but only this check's changes belong in its summary.
    before = (await notifications()).length;
    jira.comment('RANK-1', 'Newest ordinary comment', sam, at + 6000);
    jira.comment('RANK-2', 'Please review', sam, at + 5000, [me]);
    jira.comment('RANK-2', 'One more question', sam, at + 5001, [me]);
    jira.change('RANK-3', { field: 'assignee', to: me.displayName, author: sam, at: at + 3000 });
    jira.comment('RANK-3', 'For you', sam, at + 4000, [me]);
    jira.comment('RANK-4', 'Ordinary follow-up', sam, at + 2000);
    await checkNow();
    await until(async () => (await notifications()).length > before, 'ranked notification recorded');
    assert.deepEqual((await notifications()).slice(before).map(n => [n.title, n.body, n.key]), [
      ['4 issues changed · 1 assigned to you · 2 mention you', 'RANK-3, RANK-2, RANK-1, RANK-4', null],
    ]);
    // Notifications arrive before the renderer's separate state push. Wait for all rows.
    await until(async () => (await page.locator('.va-row[data-row^="RANK-"]').count()) === 4, 'all ranking rows rendered');
    // Changed retains time order, independently of notification importance.
    const order = await page.locator('.va-row').evaluateAll(rows => rows.map(r => r.dataset.row).filter(k => k.startsWith('RANK-')));
    assert.deepEqual(order, ['RANK-1', 'RANK-2', 'RANK-3', 'RANK-4']);
    await shot('22-summary-keeps-changed-time-order');
    for (const key of keys) {
      await page.click(`.va-row[data-row="${key}"]`);
      await page.click('.va-d [data-action="untrack"]');
      await page.waitForSelector(`.va-row[data-row="${key}"]`, { state: 'detached' });
    }
  });

  await t.test('updates: a newer release is announced, Later hides it, and up to date again', async () => {
    const opened = () => app.evaluate(() => global.__issuemonOpened || []);
    const status = async () => (await page.textContent('#update-status')).replace(/\s+/g, ' ').trim();
    const clearToasts = () => page.evaluate(() => document.querySelectorAll('.snack').forEach(s => s.remove()));
    const release = 'https://github.com/fundament-agency/issuemon/releases/tag/v9.9.9';
    await page.click('[data-view="settings"]');
    await page.waitForSelector('#set-checkUpdates');
    await clearToasts();
    assert.equal((await page.textContent('.about-version')).trim(), `IssueMon ${VERSION}`);
    assert.equal(await page.isChecked('#set-checkUpdates'), true);
    assert.equal(await status(), ''); // not checked yet: automatic checks do not run in the tests
    assert.equal(await page.locator('text=brew upgrade').count(), 0);

    // A newer release: toast with two actions, the status line and, on macOS, the Homebrew hint
    jira.release = '9.9.9';
    await page.click('[data-action="check-updates"]');
    await page.waitForSelector('.snack:has-text("IssueMon 9.9.9 is available")');
    assert.deepEqual(await page.locator('.snack button').allTextContents(), ['View release', 'Later']);
    await until(async () => (await status()) === 'IssueMon 9.9.9 is available · View release', 'status line with the new version');
    if (process.platform === 'darwin') assert.match(await page.textContent('.set'), /Homebrew: brew upgrade --cask issuemon/);
    else assert.doesNotMatch(await page.textContent('.set'), /Homebrew/); // the cask is macOS only
    await page.locator('fieldset:has(#set-checkUpdates)').screenshot({ path: path.join(SHOTS, '17-about-update.png') });

    // View release (toast): the release page opens in the browser, and only that kind of page can
    await page.click('.snack button:has-text("View release")');
    await until(async () => (await opened()).at(-1) === release, 'release page opened');
    assert.equal(await page.locator('.snack').count(), 0);
    const before = (await opened()).length;
    assert.equal(await page.evaluate(() => window.issuemon.openRelease('https://evil.example/fundament-agency/issuemon/releases/x')), false);
    assert.equal(await page.evaluate(() => window.issuemon.openRelease('https://github.com/fundament-agency/issuemon/issues/1')), false);
    assert.equal((await opened()).length, before);
    // ... and the link in the status line does the same
    await page.click('#update-status button:has-text("View release")');
    await until(async () => (await opened()).length === before + 1, 'status line link');
    assert.equal((await opened()).at(-1), release);

    // Later: the toast goes, the dismissed version is stored, and the status line still shows it
    await page.click('[data-action="check-updates"]'); // a manual check ignores Later
    await page.waitForSelector('.snack:has-text("IssueMon 9.9.9 is available")');
    await page.click('.snack button:has-text("Later")');
    await until(async () => (await app.evaluate(() => global.__issuemon.tracker.updates.dismissed)) === '9.9.9', 'dismissed');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.snack').count(), 0);
    assert.equal(await status(), 'IssueMon 9.9.9 is available · View release');
    assert.equal(await app.evaluate(() => global.__issuemon.tracker.publicState().updates.newer), true);

    // The release is the running version again: up to date, from the button and from the app menu
    jira.release = VERSION;
    await page.click('[data-action="check-updates"]');
    await page.waitForSelector(`.snack:has-text("You’re up to date")`);
    await until(async () => (await status()) === 'You’re up to date', 'status line up to date');
    assert.equal(await page.locator('text=brew upgrade').count(), 0);
    if (process.platform === 'darwin') {
      await clearToasts();
      const labels = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.map(i => i.label));
      assert.deepEqual(labels.slice(0, 2), ['About IssueMon', 'Check for Updates…']); // right after About
      await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items[1].click());
      await page.waitForSelector(`.snack:has-text("You’re up to date")`);
    }
    await clearToasts();

    // The setting is saved like the others
    await page.uncheck('#set-checkUpdates');
    await until(async () => (await app.evaluate(() => global.__issuemon.tracker.settings.checkUpdates)) === false, 'setting saved');
    await page.check('#set-checkUpdates');
    await until(async () => (await app.evaluate(() => global.__issuemon.tracker.settings.checkUpdates)) === true, 'setting saved again');
  });

  await t.test('theme: system, light and dark', async () => {
    await page.click('[data-view="settings"]');
    assert.equal(await page.locator('.logo').count(), 0);
    const look = () => page.evaluate(() => ({ dark: matchMedia('(prefers-color-scheme: dark)').matches, bg: getComputedStyle(document.body).backgroundColor }));
    await page.click('.seg-opt:has(input[value="dark"])');
    await page.waitForFunction(() => matchMedia('(prefers-color-scheme: dark)').matches);
    assert.deepEqual(await look(), { dark: true, bg: 'rgb(29, 27, 25)' });
    assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), 'dark');
    await shot('6-dark-settings');
    await page.click('[data-view="changed"]');
    await page.waitForSelector('.va-row');
    await shot('7-dark-changed');
    await page.click('[data-view="settings"]');
    await page.click('.seg-opt:has(input[value="light"])');
    await page.waitForFunction(() => !matchMedia('(prefers-color-scheme: dark)').matches);
    assert.deepEqual(await look(), { dark: false, bg: 'rgb(245, 242, 237)' });
    await page.click('[data-view="changed"]');
    await page.waitForSelector('.va-row');
    await shot('8-light-changed');
    await page.click('[data-view="settings"]');
    await page.click('.seg-opt:has(input[value="system"])');
    await page.waitForFunction(() => document.querySelector('.seg-opt.on input')?.value === 'system');
    assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), 'system');
  });

  await t.test('language: Dutch from Settings, back to English via the menu', async () => {
    const navLabel = () => page.textContent('.va-nav [data-view="changed"] .lbl');
    const menuLabels = () => app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map(i => i.label));
    const savedLanguage = () => JSON.parse(fs.readFileSync(storeFile, 'utf8')).settings.language;
    await page.click('[data-view="settings"]');
    await page.waitForSelector('#set-language');
    const options = await page.locator('#set-language option').allTextContents();
    assert.deepEqual(options.slice(0, 3), ['System', 'English', 'Nederlands']); // System first, then the native names
    assert.equal(await page.inputValue('#set-language'), 'en');
    assert.ok((await menuLabels()).includes('View'));

    await page.selectOption('#set-language', 'nl');
    await until(async () => (await navLabel()) === 'Gewijzigd', 'nav in Dutch');
    assert.match(await page.textContent('.va-page h1'), /^Instellingen\b/);
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'nl');
    assert.equal((await page.locator('#set-language option').first().textContent()), 'Systeem');
    await until(async () => (await menuLabels()).includes('Weergave'), 'menu in Dutch');
    const tray = await app.evaluate(() => global.__issuemon.trayLabels());
    assert.ok(tray.includes('Nu checken') && !tray.includes('Check now'), tray.join(' | '));
    // Role items carry our own labels too, not Electron's English ones
    const submenu = label => app.evaluate(({ Menu }, l) => Menu.getApplicationMenu().items.find(i => i.label === l).submenu.items.map(i => i.label), label);
    assert.ok((await submenu('Wijzig')).includes('Knip'));
    assert.ok((await submenu('Weergave')).includes('Ware grootte'));
    assert.ok((await submenu('Venster')).includes('Minimaliseer'));
    if (process.platform === 'darwin') assert.ok((await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.map(i => i.label))).includes('Verberg andere'));
    assert.equal(await app.evaluate(() => global.__issuemon.tracker.settings.language), 'nl');
    await until(async () => savedLanguage() === 'nl', 'language in the data file');

    // Back to English through View → Language (the radio item is checked for Nederlands now)
    const back = await app.evaluate(({ Menu }) => {
      const language = Menu.getApplicationMenu().items.find(i => i.label === 'Weergave').submenu.items.find(i => i.label === 'Taal');
      const checked = language.submenu.items.find(i => i.checked).label;
      language.submenu.items.find(i => i.label === 'English').click();
      return checked;
    });
    assert.equal(back, 'Nederlands');
    await until(async () => (await navLabel()) === 'Changed', 'nav in English again');
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
    assert.equal(await page.inputValue('#set-language'), 'en');
    await until(async () => (await menuLabels()).includes('View'), 'menu in English again');
  });

  await t.test('narrow window: tab bar and detail over the list', async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(400, 760));
    await page.waitForFunction(() => window.innerWidth <= 420);
    await page.click('[data-view="changed"]');
    await page.waitForSelector('.va-row[data-row="WEB-1423"]');
    await shot('4-mobile-list');
    await page.click('[data-row="WEB-1423"]');
    await page.waitForSelector('.va.detail-open .va-back');
    await shot('5-mobile-detail');
    await page.click('.va-back');
    // A toast must not cover the tab bar
    await page.fill('#add-input', 'WEB-1423');
    await page.press('#add-input', 'Enter');
    await page.waitForSelector('.snack');
    const gap = await page.evaluate(() => {
      const snack = document.querySelector('.snack').getBoundingClientRect();
      const side = document.querySelector('.va-side').getBoundingClientRect();
      return { snackBottom: snack.bottom, sideTop: side.top, snackLeft: snack.left, snackRight: snack.right, w: innerWidth };
    });
    assert.ok(gap.snackBottom <= gap.sideTop, `toast (${gap.snackBottom}) overlaps the tab bar (${gap.sideTop})`);
    assert.ok(gap.snackLeft >= 0 && gap.snackRight <= gap.w, 'toast stays inside the window');
    await shot('6-mobile-toast');
    await assertAddCleared();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1200, 780));
  });

  await t.test('another Jira site has its own tracked list, and switching back restores yours', async () => {
    const other = createMockJira({ email: 'e2e@example.com', token: 'e2e-token' });
    const otherUrl = await other.start();
    try {
      // Same ids as the issues tracked here (both sites number from 10001), under other keys and with other titles.
      for (let n = 1; n <= 12; n++) other.addIssue({ key: `ZED-${n}`, summary: `Second site issue ${n}`, status: 'To Do', updated: Date.now() - 86_400_000 });
      await page.click('[data-view="tracked"]');
      await page.waitForSelector('[data-row="WEB-1423"]');
      const rows = () => page.locator('[data-row]').evaluateAll(rs => rs.map(r => r.dataset.row));
      const before = (await rows()).sort();
      const total = await page.textContent('.va-nav [data-view="tracked"] .count');
      assert.ok(before.length >= 5);

      await page.click('[data-view="settings"]');
      await page.fill('#set-baseUrl', otherUrl);
      await page.press('#set-baseUrl', 'Tab');
      await page.click('[data-view="tracked"]');
      await page.waitForFunction(() => !document.querySelector('[data-row]'));
      await checkNow();
      await page.waitForTimeout(150);
      assert.deepEqual(await rows(), []); // nothing of the second site under an old key, and nothing of the first
      assert.equal(await page.locator('[data-row^="ZED-"]').count(), 0);
      const changed = await page.locator('.va-nav [data-view="changed"] .count').first().textContent({ timeout: 500 }).catch(() => null); // no counter at all when nothing changed
      assert.ok(!changed || changed === '0');
      await shot('9-other-site-tracked');

      await page.click('[data-view="settings"]');
      await page.fill('#set-baseUrl', url);
      await page.press('#set-baseUrl', 'Tab');
      await page.click('[data-view="tracked"]');
      await page.waitForSelector('[data-row="WEB-1423"]');
      await checkNow();
      assert.deepEqual((await rows()).sort(), before);
      assert.equal(await page.textContent('.va-nav [data-view="tracked"] .count'), total);
      assert.match(await page.textContent('[data-row="WEB-1423"]'), /WEB-1423/);
      await shot('10-first-site-restored');
    } finally {
      await other.stop();
    }
  });

  await t.test('state is kept after quitting', async () => {
    await app.evaluate(() => global.__issuemon.tracker.saveSettings({ language: 'nl' })); // the language survives the restart below
    await app.close();
    const saved = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    assert.deepEqual(saved.tracked.map(x => x.key).sort(), ['APP-88', 'OPS-310', 'OPS-311', 'WEB-1201', 'WEB-1398', 'WEB-1423']);
    assert.deepEqual(saved.notes.map(n => n.text), ['Typo on the contact page']);
    assert.equal(saved.settings.staleDays, 20);
    assert.equal(saved.settings.language, 'nl');
    assert.deepEqual(saved.settings.stalePeople, [
      { accountId: 'acc-me', name: 'Demo User' }, { accountId: 'acc-sam', name: 'Sam Rivera' }, { accountId: 'acc-alex', name: 'Alex Morgan' },
    ]);
    assert.equal(saved.secrets, undefined); // the token came from the environment, not stored

    // Start again: Dutch straight away, then back to English
    const again = await electron.launch(launchOptions(env));
    try {
      const win = await again.firstWindow();
      await win.waitForFunction(() => document.querySelector('.va-nav [data-view="changed"] .lbl')?.textContent === 'Gewijzigd');
      await again.evaluate(() => global.__issuemon.tracker.saveSettings({ language: 'en' }));
      await win.waitForFunction(() => document.querySelector('.va-nav [data-view="changed"] .lbl')?.textContent === 'Changed');
    } finally {
      await again.close();
    }
    assert.equal(JSON.parse(fs.readFileSync(storeFile, 'utf8')).settings.language, 'en');
  });
});
