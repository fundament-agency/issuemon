'use strict';
/* Notify-only update check: asks GitHub once a day for the latest release and reports whether it is newer than the
   running version. IssueMon is ad-hoc signed, so it never downloads or installs anything; the user is only told.
   No Electron import: everything it needs is injected, so it can be tested in node. */

const DEFAULT_URL = 'https://api.github.com/repos/fundament-agency/issuemon/releases/latest';
const RELEASES_PAGE = 'https://github.com/fundament-agency/issuemon/releases/latest';
const RELEASES_PREFIX = 'https://github.com/fundament-agency/issuemon/releases/';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const FIRST_DELAY = MIN; // first automatic check after launch
const RETRY_DELAY = HOUR; // after a failed automatic check: at launch the network is often not up yet
const TIMEOUT = 10_000;

/** '1.2.3' or 'v1.2.3' → [1, 2, 3]; anything else (a tag like 'nightly', a pre-release, two parts) → null. */
function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text ?? '').trim());
  return m ? m.slice(1).map(Number) : null;
}

/** 1, 0 or -1, comparing the three numbers one by one (0.10.0 > 0.9.1). Both must parse. */
function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  }
  return 0;
}

/** Is `latest` newer than `current`? A version that is not three numbers (on either side) never counts as newer. */
const isNewer = (latest, current) => !!parseVersion(latest) && !!parseVersion(current) && compareVersions(latest, current) > 0;

/** The only URLs main opens for an update: a page below the IssueMon releases on GitHub. */
function isReleaseUrl(url) {
  if (typeof url !== 'string' || !url.startsWith(RELEASES_PREFIX)) return false;
  try {
    const u = new URL(url);
    // Parsed as well: ../ segments, backslashes and credentials must not lead anywhere else.
    return u.protocol === 'https:' && u.host === 'github.com' && !u.username && !u.password && u.pathname.startsWith('/fundament-agency/issuemon/releases/');
  } catch {
    return false;
  }
}

/**
 * @param {object} o
 * @param {string} o.currentVersion  the running version, e.g. '0.1.0'
 * @param {string} [o.url]  the "latest release" endpoint; ISSUEMON_UPDATE_URL points it at a mock
 * @param {typeof fetch} o.fetch
 * @param {() => number} [o.now]
 * @param {Function} [o.setTimer]
 * @param {Function} [o.clearTimer]
 * @param {() => { lastCheck?: number|null, latest?: string|null, url?: string|null, dismissed?: string|null }} o.getState
 * @param {(patch: object) => void} o.setState  merges the patch into the stored state
 * @param {(result: { ok: true, latest: string, url: string, newer: true }) => void} [o.onResult]  an automatic check found a version to announce
 * @param {() => boolean} [o.enabled]  may automatic checks run now (the setting, a packaged app)? Manual checks always run.
 * @param {(message: string) => void} [o.log]
 */
function createUpdateChecker({
  currentVersion, url = DEFAULT_URL, fetch, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  getState, setState, onResult = () => {}, enabled = () => true, log = () => {},
}) {
  let timer = null;
  let started = false;
  let inflight = null;
  let callers = { manual: false, automatic: false }; // who is waiting for the run in flight

  const state = () => getState() || {};
  const due = () => !state().lastCheck || now() - state().lastCheck >= DAY;

  function arm(ms) {
    clearTimer(timer);
    timer = setTimer(onTimer, ms);
  }

  async function request() {
    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), TIMEOUT);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `IssueMon/${currentVersion}` },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const latest = String(body?.tag_name ?? '').trim().replace(/^v/i, '');
      if (!latest) throw new Error('no tag_name in the response');
      return { latest, url: isReleaseUrl(body.html_url) ? body.html_url : RELEASES_PAGE };
    } finally {
      clearTimeout(abort);
    }
  }

  async function run() {
    let result;
    try {
      const release = await request();
      result = { ok: true, latest: release.latest, url: release.url, newer: isNewer(release.latest, currentVersion) };
      setState({ lastCheck: now(), latest: release.latest, url: release.url });
    } catch (err) {
      log(`Update check failed: ${err.message}`);
      result = { ok: false };
    }
    // A manual result is shown by whoever asked for it, also when an automatic check joined the same run (so it is shown once);
    // an automatic one only when it has not been dismissed.
    if (!callers.manual && result.ok && result.newer && result.latest !== state().dismissed) onResult(result);
    // An automatic caller consumed the timer, so a failure needs a new one, whoever else was waiting for the run.
    if (started && result.ok) arm(DAY);
    else if (started && callers.automatic) arm(RETRY_DELAY);
    return result;
  }

  /** Never rejects. A check that is already running is shared, and keeps the rules of every caller that joined it. */
  function check({ manual = false } = {}) {
    if (!inflight) callers = { manual: false, automatic: false };
    callers[manual ? 'manual' : 'automatic'] = true;
    inflight ||= run().finally(() => { inflight = null; });
    return inflight;
  }

  async function onTimer() {
    if (!enabled()) return arm(DAY); // the setting may be switched on later
    return check();
  }

  return {
    check,
    /** "Later": that version is not announced automatically any more. A newer one is. */
    dismiss() {
      const { latest } = state();
      if (latest) setState({ dismissed: latest });
    },
    /** Starts (or restarts) the daily rhythm: 60 s after launch when a check is due, otherwise 24 h after the last one. */
    start() {
      started = true;
      arm(due() ? FIRST_DELAY : Math.min(DAY, Math.max(0, state().lastCheck + DAY - now())));
    },
    stop() {
      started = false;
      clearTimer(timer);
      timer = null;
    },
    /** After the Mac wakes up: a timer does not run during sleep, so check at once when a check is due. */
    async wake() {
      if (started && enabled() && due()) await check();
    },
  };
}

module.exports = { createUpdateChecker, parseVersion, compareVersions, isNewer, isReleaseUrl, DEFAULT_URL, RELEASES_PAGE };
