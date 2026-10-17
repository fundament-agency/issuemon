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
