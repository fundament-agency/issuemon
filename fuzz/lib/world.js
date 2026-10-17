'use strict';
/* A Tracker against the mock Jira, with a shared fake clock and a network layer that can fail requests or change Jira
 * just before a request is answered. Used by the stateful targets. */

const { Tracker } = require('../../src/main/tracker');
const { createJiraClient } = require('../../src/main/jira');
const { createMockJira } = require('../../test/support/mock-jira');

const EMAIL = 'user@example.com';
const TOKEN = 'tok';

/** Which Jira endpoint a request goes to. */
function endpointOf(pathname, method) {
  if (pathname.endsWith('/issue/bulkfetch')) return 'bulkfetch';
  if (pathname.endsWith('/changelog')) return 'changelog';
  if (/\/issue\/[^/]+\/comment$/.test(pathname)) return 'comment';
  if (pathname.endsWith('/myself')) return 'myself';
  if (pathname.endsWith('/search/jql')) return 'search';
  if (pathname.endsWith('/users/search')) return 'users';
  if (pathname.includes('/createmeta/')) return 'createmeta';
  if (method === 'POST' && pathname.endsWith('/rest/api/3/issue')) return 'create';
  return 'other';
}

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/** Transient failures only: each of these goes away by itself, so nothing may be lost because of it. */
const FAULTS = {
  server: () => json(500, { errorMessages: ['Internal server error'] }),
  unavailable: () => json(503, { errorMessages: ['Service unavailable'] }),
  gateway: () => new Response('<html><body><h1>502 Bad Gateway</h1></body></html>', { status: 502, headers: { 'Content-Type': 'text/html' } }),
  rate: () => json(429, { errorMessages: ['Rate limit exceeded.'] }, { 'Retry-After': '1' }),
  network: () => { throw new TypeError('fetch failed'); },
  // A 200 that is no answer, as a captive portal or a broken proxy sends (jira.js guards bulkfetch against this one).
  portal: () => new Response('<html><body>Sign in to the Wi-Fi</body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
  empty: () => json(200, {}),
};

/** `sites`: how many Jira sites exist (the tracker starts on the first); each is a mock with the same account email and token. */
async function createWorld({ settings = {}, sites: siteCount = 1 } = {}) {
  const clock = { t: 1_790_000_000_000 };
  const now = () => clock.t;
  const sites = [];
  for (let i = 0; i < siteCount; i++) {
    const site = createMockJira({ email: EMAIL, token: TOKEN, now });
    await site.start();
    sites.push(site);
  }
  const [jira] = sites;

  // aliases: old key → issue, after a move. Jira answers a request for an old key with the moved issue (also one already on
  // its way when the move happens); the mock only knows current keys, so its lookup by key falls back to these.
  const net = { faults: [], hooks: [], inflight: 0, requests: 0, aliases: new Map() };
  const lookup = jira.issues.get.bind(jira.issues);
  jira.issues.get = key => lookup(key) ?? (net.aliases.has(key) && lookup(net.aliases.get(key).key) === net.aliases.get(key) ? net.aliases.get(key) : undefined);
  async function fetchImpl(url, init) {
    const endpoint = endpointOf(new URL(url).pathname, init?.method || 'GET');
    net.inflight++;
    net.requests++;
    try {
      const h = net.hooks.findIndex(x => x.endpoint === endpoint);
      if (h >= 0) net.hooks.splice(h, 1)[0].run(); // Jira changes while the request is on its way
      const f = net.faults.find(x => x.endpoint === endpoint && x.left > 0);
      if (f) {
        f.left--;
        return FAULTS[f.kind]();
      }
      // Read the whole body here, so `inflight` covers the transfer and drain() knows when the network is quiet.
      const res = await fetch(url, init);
      const body = await res.arrayBuffer();
      return new Response(res.status === 204 ? null : body, { status: res.status, headers: res.headers });
    } finally {
      net.inflight--;
    }
  }

  const store = { data: { settings: { baseUrl: jira.url, email: EMAIL, notify: true, ignoreOwn: true, ...settings } }, save() {} };
  let token = TOKEN;
  const notifications = [];
  const announced = [];
  const tracker = new Tracker({
    store,
    hasToken: () => !!token,
    setToken: v => { token = v || null; },
    getClient: () => (token ? createJiraClient({ baseUrl: store.data.settings.baseUrl, email: EMAIL, token, fetch: fetchImpl, t: tracker.t, timeoutMs: 10_000 }) : null),
    notify: n => notifications.push(n),
    setTimer: () => 0,
    clearTimer: () => {},
    now,
  });
  // What each check announced (Tracker.announce gets the changes; notify only gets the wording).
  const announce = tracker.announce.bind(tracker);
  tracker.announce = fresh => {
    announced.push(fresh);
    announce(fresh);
  };

  /** Waits until no request is in flight and the event loop has settled (a failed check can leave work running). */
  async function drain() {
    for (let quiet = 0; quiet < 3;) {
      await new Promise(resolve => setImmediate(resolve));
      if (net.inflight) { quiet = 0; await new Promise(resolve => setTimeout(resolve, 1)); } else quiet++;
    }
  }

  return { clock, jira, sites, net, store, tracker, notifications, announced, drain, stop: () => Promise.all(sites.map(site => site.stop())) };
}

module.exports = { createWorld, FAULTS, endpointOf };
