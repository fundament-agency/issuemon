'use strict';
/* Isolated regression for #7: settings edits must reach Jira even when a state push redraws
   the focused field. No dependency on the notes flow or settings from an earlier sub-test. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');
const { createMockJira, seedDemo } = require('../test/support/mock-jira');

const ROOT = path.join(__dirname, '..');
const PACKAGED = process.env.ISSUEMON_APP ? path.resolve(ROOT, process.env.ISSUEMON_APP) : null;

test('stale settings: background renders preserve edits until blur, then refresh the sidebar', { timeout: 30_000 }, async t => {
  const jira = createMockJira({ email: 'e2e@example.com', token: 'e2e-token' });
  seedDemo(jira);
  const url = await jira.start();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'issuemon-stale-settings-'));
  const dataDir = path.join(userData, 'data');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'issuemon.json'), JSON.stringify({
    settings: { baseUrl: url, email: 'e2e@example.com', excluded: ['Backlog'], language: 'en' },
  }));
  let app;
  t.after(async () => {
    await app?.close().catch(() => {});
    await jira.stop();
    fs.rmSync(userData, { recursive: true, force: true });
  });
  const env = { ...process.env, ISSUEMON_E2E: '1', ISSUEMON_USER_DATA: userData, ISSUEMON_HOME: dataDir, ISSUEMON_TOKEN: 'e2e-token' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: PACKAGED || require('electron'), args: PACKAGED ? [] : [ROOT], env });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 780));
  await page.waitForFunction(() => window.innerWidth > 1100 && window.issuemon);
  await page.evaluate(() => window.issuemon.checkNow());
  const staleCount = n => page.waitForFunction(count => document.querySelector('.va-nav [data-view="stale"] .count')?.textContent === String(count), n);
  await staleCount(3);
  await page.click('[data-view="settings"]');
  await page.waitForSelector('#person-acc-sam');
  await app.evaluate(() => {
    const tracker = global.__issuemon.tracker;
    const save = tracker.saveSettings.bind(tracker);
    global.__settingsSaves = [];
    tracker.saveSettings = patch => { global.__settingsSaves.push(patch); return save(patch); };
  });

  const settings = () => page.evaluate(() => window.issuemon.getState()).then(s => s.settings);
  const saves = name => app.evaluate(key => global.__settingsSaves.filter(p => key in p), name);
  const backgroundRender = async () => {
    await page.evaluate(() => {
      window.__settingsRendered = new Promise(resolve => {
        const off = window.issuemon.onState(() => { off(); requestAnimationFrame(() => resolve()); });
      });
    });
    await app.evaluate(() => global.__issuemon.tracker.changed());
    await page.evaluate(() => window.__settingsRendered);
  };
  const editAcrossRenders = async (name, text, before, after, count) => {
    const selector = `#set-${name}`;
    const previous = (await saves(name)).length;
    await page.fill(selector, text);
    // More than one push must neither commit the draft nor lose its pending change.
    await backgroundRender();
    await backgroundRender();
    assert.equal(await page.inputValue(selector), text);
    assert.equal(await page.locator(selector).evaluate(el => el === document.activeElement), true);
    assert.deepEqual((await settings())[name], before, `${name}: background render must not save an unfinished edit`);
    assert.equal((await saves(name)).length, previous);
    await page.press(selector, 'Tab');
    assert.deepEqual((await settings())[name], after, `${name}: real blur must save the restored edit`);
    assert.equal((await saves(name)).length, previous + 1, `${name}: blur saves exactly once`);
    await staleCount(count);
  };

  await editAcrossRenders('staleDays', '20', 14, 20, 2);
  await editAcrossRenders('excluded', '', ['Backlog'], [], 3);
  await editAcrossRenders('excluded', 'Backlog', [], ['Backlog'], 2);
  await editAcrossRenders('excludedProjects', 'APP, OPS', [], ['APP', 'OPS'], 1);
  await editAcrossRenders('excludedProjects', '', ['APP', 'OPS'], [], 2);

  await page.click('#person-acc-sam');
  await page.click('#person-acc-alex');
  await staleCount(4);
  assert.deepEqual((await settings()).stalePeople.map(p => p.accountId), ['acc-me', 'acc-sam', 'acc-alex']);
  await page.click('.pchip-x[data-id="acc-alex"]');
  await staleCount(3);
  await page.click('#person-acc-alex');
  await staleCount(4);
  await page.click('#person-unassigned');
  await staleCount(5);
  assert.equal((await settings()).staleUnassigned, true);
  await page.click('.pchip-x[data-id="unassigned"]');
  await staleCount(4);
  assert.equal((await settings()).staleUnassigned, false);
});
