'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');
const { createMockJira } = require('../test/support/mock-jira');
const { launchOptions } = require('./launch');

test('Notes: edits survive renderer refreshes until saved or discarded', { timeout: 30_000 }, async t => {
  const jira = createMockJira({ email: 'e2e@example.com', token: 'e2e-token' });
  const url = await jira.start();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'issuemon-notes-'));
  const dataDir = path.join(userData, 'data');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'issuemon.json'), JSON.stringify({
    settings: { baseUrl: url, email: 'e2e@example.com', language: 'en' },
    notes: [{ id: 'cookie', text: 'Cookie banner covers the footer', createdAt: Date.now() }],
  }));
  let app;
  t.after(async () => {
    await app?.close().catch(() => {});
    await jira.stop();
    fs.rmSync(userData, { recursive: true, force: true });
  });
  const env = { ...process.env, ISSUEMON_E2E: '1', ISSUEMON_USER_DATA: userData, ISSUEMON_HOME: dataDir, ISSUEMON_TOKEN: 'e2e-token' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch(launchOptions(env));
  const page = await app.firstWindow();
  await page.click('[data-view="notes"]');
  const field = page.locator('#note-cookie');
  const savedText = () => app.evaluate(() => global.__issuemon.tracker.findNote('cookie').text);
  const waitSaved = text => page.waitForFunction(async text => (await window.issuemon.getState()).notes[0].text === text, text);
  const refresh = async () => {
    const oldField = await field.elementHandle();
    try {
      // Force the same state push that can arrive after Enter, during the next edit.
      await app.evaluate(() => global.__issuemon.tracker.changed());
      await page.waitForFunction(el => !el.isConnected, oldField);
      assert.equal(await field.evaluate(el => el === document.activeElement), true);
    } finally {
      await oldField.dispose();
    }
  };

  await t.test('Escape restores the last save even when a push replaces the edited textarea', async () => {
    const saved = 'Cookie banner covers the footer on mobile';
    await field.fill(saved);
    await field.press('Enter');
    await waitSaved(saved);
    await field.fill('discard this');
    await refresh();
    await refresh(); // carrying an edit through more than one replacement must also work
    assert.equal(await field.inputValue(), 'discard this');
    assert.equal(await savedText(), saved, 'a redraw must not commit the draft');
    await field.press('Escape');
    assert.equal(await field.inputValue(), saved);
    assert.equal(await savedText(), saved);
  });

  for (const commit of ['Enter', 'blur', 'type again then blur']) {
    await t.test(`${commit} saves an edit carried through a refresh exactly once`, async () => {
      const before = await savedText();
      const text = `Edit saved by ${commit}`;
      await app.evaluate(() => {
        const tracker = global.__issuemon.tracker;
        global.__noteEditCalls = [];
        if (tracker.recordingEdits) return;
        tracker.recordingEdits = true;
        const edit = tracker.editNote.bind(tracker);
        tracker.editNote = (id, text) => { global.__noteEditCalls.push({ id, text }); return edit(id, text); };
      });
      await field.fill(text);
      await refresh();
      assert.equal(await savedText(), before);
      if (commit === 'type again then blur') await field.fill(`${text}!`);
      if (commit === 'Enter') await field.press('Enter');
      else await page.locator('#note-input').focus();
      const expected = commit === 'type again then blur' ? `${text}!` : text;
      await waitSaved(expected);
      assert.deepEqual(await app.evaluate(() => global.__noteEditCalls), [{ id: 'cookie', text: expected }]);
    });
  }

  await t.test('menu navigation still commits the edit when the field disappears', async () => {
    const text = 'Saved when leaving Notes';
    await field.fill(text);
    await refresh();
    // Menu commands do not first click/blur the textarea like sidebar buttons do.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('command', 'settings'));
    await page.waitForSelector('#set-staleDays');
    await waitSaved(text);
    assert.equal(await savedText(), text);
  });
});

test('Notes: create an issue with an assignee and a description', { timeout: 60_000 }, async t => {
  const jira = createMockJira({ email: 'e2e@example.com', token: 'e2e-token' });
  const url = await jira.start();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'issuemon-notes-'));
  const dataDir = path.join(userData, 'data');
  fs.mkdirSync(dataDir);
  // No notes project and no default project: the panel starts without a project.
  fs.writeFileSync(path.join(dataDir, 'issuemon.json'), JSON.stringify({
    settings: { baseUrl: url, email: 'e2e@example.com', language: 'en' },
    notes: [{ id: 'banner', text: 'Cookie banner covers the footer', createdAt: Date.now() }],
  }));
  let app;
  t.after(async () => {
    await app?.close().catch(() => {});
    await jira.stop();
    fs.rmSync(userData, { recursive: true, force: true });
  });
  const env = { ...process.env, ISSUEMON_E2E: '1', ISSUEMON_USER_DATA: userData, ISSUEMON_HOME: dataDir, ISSUEMON_TOKEN: 'e2e-token' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch(launchOptions(env));
  const page = await app.firstWindow();
  const created = () => jira.requests.filter(q => q.method === 'POST' && q.path === '/rest/api/3/issue');
  const focused = () => page.evaluate(() => document.activeElement?.id);
  await page.click('[data-view="notes"]');
  await page.click('[data-action="note-issue"][data-id="banner"]');
  await page.waitForSelector('#draft-summary');

  await t.test('without a project the hint is neutral, and red only after Create', async () => {
    const hint = page.locator('#draft-project-hint');
    assert.match(await hint.textContent(), /Enter a project\. The issue gets the project’s default type\./);
    assert.equal(await page.locator('[data-draft] .err-text').count(), 0);
    await page.click('[data-action="draft-create"]');
    await page.waitForSelector('#draft-project-hint.err-text');
    fs.mkdirSync(path.join(__dirname, 'screenshots'), { recursive: true });
    await page.screenshot({ path: path.join(__dirname, 'screenshots', 'notes-draft-no-project.png') });
    assert.equal(created().length, 0);
    assert.equal(await focused(), 'draft-project');
    await page.keyboard.type('ops');
    await page.keyboard.press('Tab');
    await page.waitForSelector('#draft-type:not([disabled])');
    assert.equal(await page.locator('#draft-project-hint').count(), 0);
  });

  await t.test('the assignee is Unassigned by default and picked with the keyboard', async () => {
    assert.match(await page.textContent('#draft-assignee'), /Unassigned/);
    await page.focus('#draft-assignee');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-draft] .fmenu');
    // Unassigned first, then you, then everyone else on the site by name: no apps, no deactivated accounts
    await page.waitForFunction(() => document.querySelectorAll('[data-draft] .fmenu .fitem').length === 6);
    assert.deepEqual(await page.locator('[data-draft] .fmenu .fitem .fname').allTextContents(),
      ['Unassigned', 'You', 'Alex Morgan', 'Jordan Lee', 'Priya Patel', 'Sam Rivera']);
    assert.equal(await page.getAttribute('[data-draft] .fitem[aria-pressed="true"]', 'data-id'), '');
    await page.screenshot({ path: path.join(__dirname, 'screenshots', 'notes-draft-assignee.png') });
    // Esc closes only the menu, not the panel
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-draft] .fmenu', { state: 'detached' });
    assert.equal(await focused(), 'draft-assignee');
    assert.equal(await page.locator('[data-draft]').count(), 1);
    // Arrows walk through the menu (wrapping), Enter picks
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-draft] .fmenu');
    await page.keyboard.press('ArrowUp');
    assert.match(await page.evaluate(() => document.activeElement.textContent), /Sam Rivera/);
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-draft] .fmenu', { state: 'detached' });
    assert.match(await page.textContent('#draft-assignee'), /Sam Rivera/);
    assert.equal(await focused(), 'draft-assignee');
  });

  await t.test('a description of a few lines: Enter is a new line, not Create', async () => {
    await page.focus('#draft-description');
    await page.keyboard.type('Only on mobile.');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Safari and Chrome.');
    assert.equal(await page.inputValue('#draft-description'), 'Only on mobile.\nSafari and Chrome.');
    assert.equal(created().length, 0);
    await page.screenshot({ path: path.join(__dirname, 'screenshots', 'notes-draft-description.png') });
  });

  await t.test('Create sends both; the tracked issue shows the assignee', async () => {
    await page.click('[data-action="draft-create"]');
    await page.waitForSelector('.snack.ok:has-text("OPS-1 created and now tracked")');
    assert.equal(created().length, 1);
    const issue = jira.issues.get('OPS-1');
    assert.equal(issue.fields.assignee.accountId, 'acc-sam');
    assert.deepEqual(issue.fields.description, { type: 'doc', version: 1, content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Only on mobile.' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Safari and Chrome.' }] },
    ] });
    await page.click('.snack:has-text("created") button'); // View
    await page.waitForSelector('.va-row.sel[data-row="OPS-1"]');
    assert.match(await page.textContent('.va-row[data-row="OPS-1"] .va-row-sub'), /Sam Rivera/);
  });
});
