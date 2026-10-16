'use strict';
/* API token storage. The token lives in our own data file (`store.data.secrets = { token }`), which the
 * store writes with mode 0600 in a folder with mode 0700. IssueMon does not touch the macOS keychain.
 * ISSUEMON_TOKEN in the environment wins over the stored token and is never stored. */

/**
 * @param {object} deps
 * @param {() => {data: object, save(): void}} deps.getStore  the JSON store (only available after startup)
 * @param {object} [deps.env]
 */
function createSecrets({ getStore, env = process.env }) {
  const read = () => env.ISSUEMON_TOKEN || getStore().data.secrets?.token || null;

  return {
    get: () => read(),
    has: () => !!read(),
    /** Empty value = delete. With ISSUEMON_TOKEN set, nothing is stored. */
    set(token) {
      if (env.ISSUEMON_TOKEN) return;
      const store = getStore();
      if (token) store.data.secrets = { token };
      else delete store.data.secrets;
      store.save();
    },
  };
}

module.exports = { createSecrets };
