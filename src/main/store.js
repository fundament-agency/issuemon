'use strict';
/* JSON storage (the path comes from paths.js). Writes debounced and atomically (tmp file + rename). */

const fs = require('node:fs');
const path = require('node:path');

function createStore(file, { debounceMs = 400 } = {}) {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Don't silently overwrite a broken file: keep a copy.
      try { fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
    }
  }

  let timer = null;
  const store = {
    file,
    data,
    save() {
      clearTimeout(timer);
      timer = setTimeout(() => store.flush(), debounceMs);
    },
    flush() {
      clearTimeout(timer);
      timer = null;
      const dir = path.dirname(file);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      try { fs.chmodSync(dir, 0o700); } catch { /* exotic filesystem without modes */ }
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(store.data, null, 2), { mode: 0o600 });
      // The mode above only counts for a file that is created: a leftover tmp file keeps its old one.
      try { fs.chmodSync(tmp, 0o600); } catch { /* exotic filesystem without modes */ }
      fs.renameSync(tmp, file);
    },
  };
  return store;
}

module.exports = { createStore };
