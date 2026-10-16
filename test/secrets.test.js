'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSecrets } = require('../src/main/secrets');

function setup({ data = {}, env = {} } = {}) {
  const store = { data, saves: 0, save() { this.saves++; } };
  const secrets = createSecrets({ getStore: () => store, env });
  return { secrets, store };
}

test('get, has and set keep the token in the data file', () => {
  const { secrets, store } = setup({ data: { settings: { x: 1 } } });
  assert.equal(secrets.has(), false);
  assert.equal(secrets.get(), null);
  secrets.set('secret');
  assert.deepEqual(store.data.secrets, { token: 'secret' });
  assert.deepEqual(store.data.settings, { x: 1 });
  assert.equal(secrets.get(), 'secret');
  assert.equal(secrets.has(), true);
  secrets.set('new');
  assert.equal(secrets.get(), 'new');
});

test('an existing token in the file is read (after a restart)', () => {
  const { secrets, store } = setup({ data: { secrets: { token: 'saved' } } });
  assert.equal(secrets.has(), true);
  assert.equal(secrets.get(), 'saved');
  assert.equal(store.saves, 0);
});

test('set with an empty value removes the token', () => {
  const { secrets, store } = setup({ data: { secrets: { token: 'x' } } });
  secrets.set('');
  assert.equal(store.data.secrets, undefined);
  assert.equal(secrets.get(), null);
  assert.equal(secrets.has(), false);
  assert.equal(store.saves, 1);
});

test('ISSUEMON_TOKEN wins and is never stored', () => {
  const { secrets, store } = setup({ env: { ISSUEMON_TOKEN: 'from-env' } });
  assert.equal(secrets.has(), true);
  assert.equal(secrets.get(), 'from-env');
  secrets.set('other');
  secrets.set('');
  assert.equal(secrets.get(), 'from-env');
  assert.equal(store.data.secrets, undefined);
  assert.equal(store.saves, 0);
});

test('ISSUEMON_TOKEN wins over a token in the file, which stays untouched', () => {
  const { secrets, store } = setup({ env: { ISSUEMON_TOKEN: 'from-env' }, data: { secrets: { token: 'saved' } } });
  assert.equal(secrets.get(), 'from-env');
  secrets.set('');
  assert.deepEqual(store.data.secrets, { token: 'saved' });
});
