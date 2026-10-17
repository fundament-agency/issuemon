'use strict';
/* Loads the real renderer (src/renderer/app.js and the scripts index.html loads before it) in a node vm, with a stub DOM.
 * app.js keeps everything inside one closure; a single line is added before its event wiring so the fuzzer can call
 * draw() (the whole window's HTML) with a state and UI of its choice. Nothing else in app.js changes. */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..', 'src');
const SCRIPTS = [
  'shared/keys.js', 'shared/diff.js',
  'shared/locales/en.js', 'shared/locales/nl.js', 'shared/locales/fr.js', 'shared/locales/de.js', 'shared/locales/es.js',
  'shared/i18n.js', 'shared/inbox.js', 'shared/text.js', 'shared/change.js', 'shared/rules.js',
  'renderer/actions.js', 'renderer/reveal.js', 'renderer/app.js',
];

/** An object that is every DOM thing at once: any property is another stub, calling it returns a stub, iterating yields nothing. */
function stub() {
  const target = function () {};
  return new Proxy(target, {
    get(_, prop) {
      if (prop === Symbol.iterator) return function* () {};
      if (prop === Symbol.toPrimitive) return () => '';
      if (prop === 'then') return undefined; // not a promise
      if (prop === 'length') return 0;
      return stub();
    },
    apply: () => stub(),
    construct: () => stub(),
    set: () => true,
  });
}

const HOOK = `
  self.__fuzz = (() => {
    const blank = JSON.stringify(UI);
    return {
      /** Sets the state from main and the UI state, settles the selection like render() does, and returns draw(). */
      draw(state, ui) {
        S = state;
        t = createTranslator(resolveLanguage(state.settings.language, state.env?.locale), state.env?.locale);
        diffMemo.clear();
        for (const k of Object.keys(UI)) delete UI[k];
        Object.assign(UI, JSON.parse(blank), ui);
        Object.assign(UI, settle(S, UI, { wide: true, locale: t.locale }));
        return draw();
      },
    };
  })();
`;

let cached = null;

/** { draw(state, ui) → HTML } from a fresh copy of the renderer (loaded once per process). */
function loadRenderer() {
  if (cached) return cached;
  const sandbox = {
    console,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    matchMedia: () => ({ matches: true, addEventListener: () => {} }),
    document: stub(), navigator: stub(), localStorage: stub(), CSS: { escape: s => s },
    issuemon: new Proxy({ platform: 'darwin', getState: () => new Promise(() => {}) }, {
      get: (target, prop) => (prop in target ? target[prop] : () => new Promise(() => {})),
    }),
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const file of SCRIPTS) {
    let code = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (file === 'renderer/app.js') {
      const anchor = '  api.onState(receive);';
      if (!code.includes(anchor)) throw new Error('fuzz/lib/renderer.js: app.js no longer has the line the hook goes before');
      code = code.replace(anchor, `${HOOK}\n${anchor}`);
    }
    vm.runInContext(code, sandbox, { filename: path.join(ROOT, file) });
  }
  cached = sandbox.__fuzz;
  return cached;
}

module.exports = { loadRenderer };
