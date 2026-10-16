const test = require('node:test');
const assert = require('node:assert/strict');
const { createUpdateChecker, compareVersions, isNewer, parseVersion, isReleaseUrl, DEFAULT_URL, RELEASES_PAGE } = require('../src/main/updates.js');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const START = 1_700_000_000_000;
const RELEASE = 'https://github.com/fundament-agency/issuemon/releases/tag/v0.2.0';
const reply200 = { tag_name: 'v0.2.0', html_url: RELEASE };

/** A checker with a fake clock, fake timers and a fake fetch; `fire()` advances the clock and runs the pending timer. */
function setup({ currentVersion = '0.1.0', state = {}, reply = reply200, enabled = () => true, fetch } = {}) {
  const calls = [];
  const announced = [];
  const logs = [];
  const timers = [];
  const clock = { now: START };
  let stored = { lastCheck: null, latest: null, url: null, dismissed: null, ...state };
  const checker = createUpdateChecker({
    currentVersion,
    fetch: fetch || (async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => reply };
    }),
    now: () => clock.now,
    setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer: timer => { if (timer) timer.cleared = true; },
    getState: () => stored,
    setState: patch => { stored = { ...stored, ...patch }; },
    onResult: result => announced.push(result),
    enabled,
    log: message => logs.push(message),
  });
  const pending = () => timers.filter(t => !t.cleared).at(-1);
  const fire = async () => {
    const timer = pending();
    assert.ok(timer, 'a timer is pending');
    timer.cleared = true;
    clock.now += timer.ms;
    await timer.fn();
  };
  return { checker, calls, announced, logs, clock, pending, fire, state: () => stored };
}

test('versions: three numeric parts are compared per part, not as text', () => {
  assert.equal(isNewer('0.10.0', '0.9.1'), true);
  assert.equal(isNewer('0.2.0', '0.1.0'), true);
  assert.equal(isNewer('1.0.0', '0.99.99'), true);
  assert.equal(isNewer('0.1.1', '0.1.0'), true);
  assert.equal(isNewer('0.1.0', '0.1.0'), false);
  assert.equal(isNewer('0.1.0', '0.2.0'), false);
  assert.equal(isNewer('0.9.1', '0.10.0'), false);
  assert.equal(compareVersions('0.10.0', '0.9.1'), 1);
  assert.equal(compareVersions('0.9.1', '0.10.0'), -1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
});

test('versions: a leading v is stripped; anything that is not three numbers is never newer', () => {
  assert.deepEqual(parseVersion('v1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseVersion('1.2.3'), [1, 2, 3]);
  assert.equal(parseVersion('nightly'), null);
  assert.equal(parseVersion('1.2'), null);
  assert.equal(parseVersion('1.2.3-beta.1'), null);
  assert.equal(parseVersion(undefined), null);
  assert.equal(isNewer('nightly', '0.1.0'), false);
  assert.equal(isNewer('v9.9.9', 'dev'), false);
  assert.equal(isNewer('1.2', '0.1.0'), false);
  assert.equal(isNewer(null, '0.1.0'), false);
});

test('only release pages of IssueMon on GitHub may be opened', () => {
  assert.equal(isReleaseUrl(RELEASE), true);
  assert.equal(isReleaseUrl(RELEASES_PAGE), true);
  assert.equal(isReleaseUrl('https://github.com/fundament-agency/issuemon/releases/'), true);
  for (const url of [
    'https://github.com/fundament-agency/issuemon',
    'https://github.com/fundament-agency/issuemon/releases', // without the slash: not a release page
    'https://github.com/fundament-agency/issuemon/issues/1',
    'https://github.com/fundament-agency/issuemon-evil/releases/x',
    'https://github.com/other/issuemon/releases/x',
    'https://github.com.evil.example/fundament-agency/issuemon/releases/x',
    'https://github.com@evil.example/fundament-agency/issuemon/releases/x',
    'https://user:pw@github.com/fundament-agency/issuemon/releases/x',
    'https://github.com/fundament-agency/issuemon/releases/../../evil',
    'https://github.com/fundament-agency/issuemon/releases/..\\..\\evil',
    'http://github.com/fundament-agency/issuemon/releases/x',
    'javascript:alert(1)',
    'file:///etc/passwd',
    '', null, undefined, 42,
  ]) assert.equal(isReleaseUrl(url), false, String(url));
});

test('the request is a GET to the releases API with an Accept and a User-Agent header', async () => {
  const { checker, calls } = setup({ currentVersion: '0.1.0' });
  await checker.check({ manual: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, DEFAULT_URL);
  assert.equal(DEFAULT_URL, 'https://api.github.com/repos/fundament-agency/issuemon/releases/latest');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Accept, 'application/vnd.github+json');
  assert.equal(calls[0].init.headers['User-Agent'], 'IssueMon/0.1.0');
  assert.ok(calls[0].init.signal, 'has a timeout signal');
});

test('the url can be overridden', async () => {
  const calls = [];
  const checker = createUpdateChecker({
    currentVersion: '0.1.0', url: 'http://127.0.0.1:1/x', getState: () => ({}), setState() {},
    fetch: async url => { calls.push(url); return { ok: true, json: async () => reply200 }; },
  });
  await checker.check({ manual: true });
  assert.deepEqual(calls, ['http://127.0.0.1:1/x']);
});

test('a newer release gives { ok, latest, url, newer } and is stored without the v', async () => {
  const { checker, state, clock } = setup();
  const result = await checker.check({ manual: true });
  assert.deepEqual(result, { ok: true, latest: '0.2.0', url: RELEASE, newer: true });
  assert.deepEqual(state(), { lastCheck: clock.now, latest: '0.2.0', url: RELEASE, dismissed: null });
});

test('the same version is not newer; a non-numeric tag is not newer either', async () => {
  assert.equal((await setup({ reply: { tag_name: 'v0.1.0', html_url: RELEASE } }).checker.check({ manual: true })).newer, false);
  assert.equal((await setup({ reply: { tag_name: 'nightly', html_url: RELEASE } }).checker.check({ manual: true })).newer, false);
});

test('a release url that may not be opened is replaced by the releases page', async () => {
  const { checker } = setup({ reply: { tag_name: 'v0.2.0', html_url: 'https://evil.example/x' } });
  assert.equal((await checker.check({ manual: true })).url, RELEASES_PAGE);
  const { checker: missing } = setup({ reply: { tag_name: 'v0.2.0' } });
  assert.equal((await missing.check({ manual: true })).url, RELEASES_PAGE);
});

test('failures give { ok: false }, are logged, never thrown and leave the stored state alone', async () => {
  const cases = {
    'fetch rejects': async () => { throw new TypeError('fetch failed'); },
    'rate limit': async () => ({ ok: false, status: 403, json: async () => ({}) }),
    'not found': async () => ({ ok: false, status: 404, json: async () => ({}) }),
    'bad JSON': async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } }),
    'no tag': async () => ({ ok: true, status: 200, json: async () => ({ html_url: RELEASE }) }),
    'not an object': async () => ({ ok: true, status: 200, json: async () => null }),
  };
  for (const [name, fetch] of Object.entries(cases)) {
    const { checker, logs, state } = setup({ fetch, state: { lastCheck: 5, latest: '0.1.5' } });
    assert.deepEqual(await checker.check({ manual: true }), { ok: false }, name);
    assert.equal(logs.length, 1, name);
    assert.equal(state().lastCheck, 5, name);
    assert.equal(state().latest, '0.1.5', name);
  }
});

test('a request that takes longer than 10 s is aborted', async () => {
  let signal;
  const { checker, logs } = setup({
    fetch: (_url, init) => new Promise((_resolve, reject) => {
      signal = init.signal;
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  });
  const realSetTimeout = global.setTimeout;
  let delay;
  global.setTimeout = (fn, ms, ...rest) => { delay = ms; return realSetTimeout(fn, 5, ...rest); }; // the 10 s, made short for the test
  try {
    assert.deepEqual(await checker.check({ manual: true }), { ok: false });
  } finally {
    global.setTimeout = realSetTimeout;
  }
  assert.equal(delay, 10_000);
  assert.equal(signal.aborted, true);
  assert.equal(logs.length, 1);
});

test('two checks at the same time share one request', async () => {
  const { checker, calls } = setup();
  const [a, b] = await Promise.all([checker.check({ manual: true }), checker.check()]);
  assert.equal(calls.length, 1);
  assert.deepEqual(a, b);
});

/** A fetch that stays open until `settle(...)` is called, so two checks can overlap. */
function gate(reply = reply200) {
  let release;
  const open = new Promise(resolve => { release = resolve; });
  return {
    fetch: async () => { await open; if (reply instanceof Error) throw reply; return { ok: true, json: async () => reply }; },
    settle: release,
  };
}

test('the daily timer firing during a failing manual check still schedules the retry in an hour', async () => {
  const g = gate(new TypeError('offline'));
  const { checker, pending, state } = setup({ fetch: g.fetch });
  checker.start();
  const timer = pending();
  timer.cleared = true; // the timer fires: it is no longer pending
  const manual = checker.check({ manual: true });
  const automatic = timer.fn(); // joins the run of the manual check
  g.settle();
  await Promise.all([manual, automatic]);
  assert.equal(state().lastCheck, null);
  assert.equal(pending().ms, HOUR);
});

test('a failing manual check alone does not touch the timer that is pending', async () => {
  const g = gate(new TypeError('offline'));
  const { checker, pending } = setup({ fetch: g.fetch });
  checker.start();
  const timer = pending();
  const manual = checker.check({ manual: true });
  g.settle();
  await manual;
  assert.equal(pending(), timer);
});

test('a manual check that joins a running automatic one announces the result once: the caller shows it, onResult does not', async () => {
  const g = gate();
  const { checker, announced } = setup({ fetch: g.fetch });
  const automatic = checker.check();
  const manual = checker.check({ manual: true });
  g.settle();
  const [a, m] = await Promise.all([automatic, manual]);
  assert.equal(m.newer, true);
  assert.deepEqual(a, m);
  assert.deepEqual(announced, []);
});

test('an automatic check that joins a running manual one announces nothing either: the manual caller shows the result', async () => {
  const g = gate();
  const { checker, announced } = setup({ fetch: g.fetch });
  const manual = checker.check({ manual: true });
  const automatic = checker.check();
  g.settle();
  await Promise.all([manual, automatic]);
  assert.deepEqual(announced, []);
});

test('an automatic check on its own is still announced after the overlap rules', async () => {
  const { checker, announced } = setup();
  await checker.check({ manual: true });
  await checker.check();
  assert.equal(announced.length, 1);
});

test('start: the first automatic check comes 60 s after launch when never checked', async () => {
  const { checker, pending, fire, calls, announced } = setup();
  checker.start();
  assert.equal(pending().ms, MIN);
  assert.equal(calls.length, 0);
  await fire();
  assert.equal(calls.length, 1);
  assert.deepEqual(announced.map(r => r.latest), ['0.2.0']);
});

test('start: 60 s after launch too when the last check is more than 24 h ago', () => {
  const { checker, pending } = setup({ state: { lastCheck: START - DAY - 1 } });
  checker.start();
  assert.equal(pending().ms, MIN);
});

test('start: no check before 24 h have passed since the last one', () => {
  const { checker, pending, calls } = setup({ state: { lastCheck: START - 5 * HOUR } });
  checker.start();
  assert.equal(pending().ms, 19 * HOUR);
  assert.equal(calls.length, 0);
});

test('start: a last check in the future (the clock was set back) does not postpone the next one by more than 24 h', () => {
  const { checker, pending } = setup({ state: { lastCheck: START + 30 * DAY } });
  checker.start();
  assert.equal(pending().ms, DAY);
});

test('after an automatic check the next one is 24 h later, and so on', async () => {
  const { checker, pending, fire, calls } = setup();
  checker.start();
  await fire();
  assert.equal(pending().ms, DAY);
  await fire();
  assert.equal(calls.length, 2);
  assert.equal(pending().ms, DAY);
  await fire();
  assert.equal(calls.length, 3);
});

test('after a failed automatic check it tries again in an hour (at launch the network is often not up yet)', async () => {
  let up = false;
  const { checker, pending, fire, state } = setup({
    fetch: async () => {
      if (!up) throw new TypeError('offline');
      return { ok: true, json: async () => reply200 };
    },
  });
  checker.start();
  await fire();
  assert.equal(state().lastCheck, null);
  assert.equal(pending().ms, HOUR);
  up = true;
  await fire();
  assert.equal(state().latest, '0.2.0');
  assert.equal(pending().ms, DAY);
});

test('a manual check pushes the next automatic one to 24 h after it', async () => {
  const { checker, pending } = setup();
  checker.start();
  await checker.check({ manual: true });
  assert.equal(pending().ms, DAY);
});

test('a manual check does not start timers on a checker that was never started', async () => {
  const { checker, pending } = setup();
  await checker.check({ manual: true });
  assert.equal(pending(), undefined);
});

test('an automatic result for the dismissed version is stored but not announced', async () => {
  const { checker, fire, announced, state } = setup({ state: { dismissed: '0.2.0' } });
  checker.start();
  await fire();
  assert.deepEqual(announced, []);
  assert.equal(state().latest, '0.2.0');
  assert.equal(state().dismissed, '0.2.0');
});

test('a version newer than the dismissed one is announced again', async () => {
  const { checker, fire, announced } = setup({ state: { dismissed: '0.1.5' } });
  checker.start();
  await fire();
  assert.equal(announced.length, 1);
});

test('an automatic check that finds nothing newer announces nothing', async () => {
  const { checker, fire, announced } = setup({ reply: { tag_name: 'v0.1.0', html_url: RELEASE } });
  checker.start();
  await fire();
  assert.deepEqual(announced, []);
});

test('a manual check ignores the dismissed version, and does not go through onResult', async () => {
  const { checker, announced } = setup({ state: { dismissed: '0.2.0' } });
  assert.equal((await checker.check({ manual: true })).newer, true);
  assert.deepEqual(announced, []); // the caller shows a manual result itself
});

test('dismiss stores the latest version, and keeps it across later checks', async () => {
  const { checker, state } = setup();
  await checker.check({ manual: true });
  checker.dismiss();
  assert.equal(state().dismissed, '0.2.0');
  await checker.check({ manual: true });
  assert.equal(state().dismissed, '0.2.0');
});

test('dismiss without a known latest version does nothing', () => {
  const { checker, state } = setup();
  checker.dismiss();
  assert.equal(state().dismissed, null);
});

test('when automatic checks are off nothing is requested, but the timer keeps running', async () => {
  let on = false;
  const { checker, fire, calls, pending, announced } = setup({ enabled: () => on });
  checker.start();
  await fire();
  assert.equal(calls.length, 0);
  assert.equal(pending().ms, DAY);
  on = true;
  await fire();
  assert.equal(calls.length, 1);
  assert.equal(announced.length, 1);
});

test('when automatic checks are off a manual check still runs', async () => {
  const { checker, calls } = setup({ enabled: () => false });
  assert.equal((await checker.check({ manual: true })).ok, true);
  assert.equal(calls.length, 1);
});

test('wake: checks right away when the last check is more than 24 h ago or missing, otherwise not', async () => {
  const old = setup({ state: { lastCheck: START - DAY - 1 } });
  old.checker.start();
  await old.checker.wake();
  assert.equal(old.calls.length, 1);
  assert.equal(old.announced.length, 1);
  assert.equal(old.pending().ms, DAY);

  const never = setup();
  never.checker.start();
  await never.checker.wake();
  assert.equal(never.calls.length, 1);

  const recent = setup({ state: { lastCheck: START - DAY + MIN } });
  recent.checker.start();
  await recent.checker.wake();
  assert.equal(recent.calls.length, 0);

  const off = setup({ state: { lastCheck: 1 }, enabled: () => false });
  off.checker.start();
  await off.checker.wake();
  assert.equal(off.calls.length, 0);

  const idle = setup({ state: { lastCheck: 1 } });
  await idle.checker.wake(); // never started
  assert.equal(idle.calls.length, 0);
});

test('stop clears the timer', () => {
  const { checker, pending } = setup();
  checker.start();
  checker.stop();
  assert.equal(pending(), undefined);
});

test('start twice leaves one timer', () => {
  const { checker, pending } = setup();
  checker.start();
  const first = pending();
  checker.start();
  assert.equal(first.cleared, true);
  assert.notEqual(pending(), first);
});
