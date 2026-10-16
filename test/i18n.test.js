'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LANGUAGES, LANGUAGE_NAMES, LANGUAGE_SETTINGS, resolveLanguage, systemLocale, localeTag, createTranslator, catalogs } = require('../src/shared/i18n');

test('languages: the registered catalogs in the fixed order, with native names and system as a setting', () => {
  assert.deepEqual(LANGUAGES.slice(0, 2), ['en', 'nl']);
  const order = ['en', 'nl', 'fr', 'de', 'es'];
  assert.deepEqual(LANGUAGES, order.filter(code => LANGUAGES.includes(code)));
  assert.deepEqual(Object.keys(catalogs).sort(), [...LANGUAGES].sort());
  assert.deepEqual(LANGUAGE_NAMES, { en: 'English', nl: 'Nederlands', fr: 'Français', de: 'Deutsch', es: 'Español' });
  assert.deepEqual(LANGUAGE_SETTINGS, ['system', ...LANGUAGES]);
});

test('resolveLanguage: a supported setting wins, otherwise the system language, otherwise English', () => {
  assert.equal(resolveLanguage('nl', 'en-US'), 'nl');
  assert.equal(resolveLanguage('en', 'nl-NL'), 'en');
  assert.equal(resolveLanguage('system', 'nl-NL'), 'nl');
  assert.equal(resolveLanguage('system', 'nl'), 'nl');
  assert.equal(resolveLanguage('system', 'nl_BE'), 'nl');
  assert.equal(resolveLanguage(undefined, 'en'), 'en');
  assert.equal(resolveLanguage('xx', 'nl-NL'), 'nl'); // invalid setting: the system decides
  assert.equal(resolveLanguage('system', 'ja-JP'), 'en'); // unsupported system language
  assert.equal(resolveLanguage('system', undefined), 'en');
  assert.equal(resolveLanguage(null, ''), 'en');
});

test('systemLocale: the Chromium locale, unless macOS asks first for a language Chromium did not choose', () => {
  assert.equal(systemLocale('en-US', ['en-US']), 'en-US');
  assert.equal(systemLocale('en-GB', ['en-AU']), 'en-GB'); // a regional variant keeps Chromium's match
  assert.equal(systemLocale('es-419', ['es-MX']), 'es-419');
  assert.equal(systemLocale('nl', ['nl-NL']), 'nl');
  assert.equal(systemLocale('en-US', ['it-IT']), 'it-IT'); // not shipped: Chromium fell back to English
  assert.equal(systemLocale('de', ['it-IT', 'de-DE']), 'it-IT'); // not to the second macOS language
  assert.equal(systemLocale('en-US', []), 'en-US');
  assert.equal(systemLocale('nl'), 'nl');
  // What the app does with it: English with en-GB dates, as for any unsupported language
  assert.equal(resolveLanguage('system', systemLocale('de', ['it-IT', 'de-DE'])), 'en');
  assert.equal(localeTag('en', systemLocale('en-US', ['it-IT'])), 'en-GB');
});

test('localeTag: the system locale when it matches the language, otherwise the language default', () => {
  assert.equal(localeTag('en', 'en-US'), 'en-US');
  assert.equal(localeTag('nl', 'nl-BE'), 'nl-BE');
  assert.equal(localeTag('nl', 'nl'), 'nl');
  assert.equal(localeTag('en', 'nl-NL'), 'en-GB');
  assert.equal(localeTag('nl', 'en-US'), 'nl-NL');
  assert.equal(localeTag('nl', undefined), 'nl-NL');
  assert.equal(localeTag('fr', 'de-DE'), 'fr-FR');
  assert.equal(localeTag('de', undefined), 'de-DE');
  assert.equal(localeTag('es', 'es-MX'), 'es-MX');
});

test('createTranslator: language, locale and has', () => {
  const t = createTranslator('nl', 'en-US');
  assert.equal(t.language, 'nl');
  assert.equal(t.locale, 'nl-NL');
  assert.equal(createTranslator('en', 'en-US').locale, 'en-US');
  assert.equal(createTranslator('xx').language, 'en'); // unknown language: English
  assert.equal(t.has('menu.checkNow'), true);
  assert.equal(t.has('does.not.exist'), false);
});

test('createTranslator: interpolation, a missing param becomes empty', () => {
  const en = createTranslator('en');
  const nl = createTranslator('nl');
  assert.equal(en('status.connectedAs', { name: 'Sam' }), 'Connected as Sam');
  assert.equal(nl('status.connectedAs', { name: 'Sam' }), 'Verbonden als Sam');
  assert.equal(en('status.connectedAs'), 'Connected as ');
  assert.equal(en('error.jira.network', { host: 'x.atlassian.net' }), 'No connection to x.atlassian.net.');
});

test('createTranslator: plural messages follow Intl.PluralRules of the language', () => {
  const en = createTranslator('en');
  const nl = createTranslator('nl');
  assert.equal(en('notify.changes', { n: 1, key: 'WEB-1' }), 'WEB-1 changed');
  assert.equal(en('notify.changes', { n: 2, key: 'WEB-1' }), 'WEB-1 · 2 changes');
  assert.equal(en('notify.changes', { n: 0, key: 'WEB-1' }), 'WEB-1 · 0 changes'); // English: 0 is plural
  assert.equal(nl('notify.changes', { n: 1, key: 'WEB-1' }), 'WEB-1 gewijzigd');
  assert.equal(nl('notify.changes', { n: 3, key: 'WEB-1' }), 'WEB-1 · 3 wijzigingen');
  assert.equal(en('notify.changes', { key: 'WEB-1' }), 'WEB-1 ·  changes'); // without n: other
  assert.equal(nl('notify.summary', { n: 4 }), '4 issues gewijzigd');
});

test('createTranslator: French plural rules make 0 singular', { skip: !LANGUAGES.includes('fr') && 'no French catalog yet' }, () => {
  const fr = createTranslator('fr');
  assert.equal(new Intl.PluralRules('fr').select(0), 'one');
  assert.equal(fr('notify.summary', { n: 0 }), catalogs.fr['notify.summary'].one.replace('{n}', '0'));
});

test('createTranslator: falls back to English, then to the key', () => {
  const nl = createTranslator('nl');
  const saved = catalogs.nl['menu.checkNow'];
  delete catalogs.nl['menu.checkNow'];
  try {
    assert.equal(nl('menu.checkNow'), 'Check now');
  } finally {
    catalogs.nl['menu.checkNow'] = saved;
  }
  assert.equal(nl('does.not.exist'), 'does.not.exist');
  assert.equal(nl('does.not.exist', { n: 2 }), 'does.not.exist');
});

/* ---------- catalog completeness ---------- */

const placeholders = msg => [...new Set([...String(msg).matchAll(/\{(\w+)\}/g)].map(m => m[1]))].sort();
const forms = msg => (typeof msg === 'object' ? Object.values(msg) : [msg]);
/** [form name, text] pairs: one '' pair for a plain string, one per plural form otherwise. */
const formEntries = msg => (typeof msg === 'object' ? Object.entries(msg) : [['', msg]]);
/** The source text for one form of a translation: the same form, else English's other. */
const sourceForm = (source, form) => (typeof source === 'object' ? source[form] ?? source.other : source);
// Texts that may stay identical to English: brand and Jira words and pure layouts of placeholders everywhere ('*'),
// plus the words each language really spells like English.
const UNTRANSLATED = {
  '*': ['Status', 'Labels', 'Sprint', 'Type', 'Issues', 'IssueMon ({n})', '{type} in {project}', 'IssueMon {version}', 'Homebrew: {command}'],
  nl: ['Fix version', 'Key', 'Stale', 'Stale issues', 'Project', 'PROJECT', 'Open IssueMon', 'Open in Jira', '{n}{plus} issue', '{n}{plus} issues', 'Zoom', 'Later'],
  fr: ['Description', 'Notes', 'Note', 'Notifications', 'Services', 'Zoom'],
  de: [],
  es: ['Zoom'],
};
const untranslated = code => new Set([...UNTRANSLATED['*'], ...(UNTRANSLATED[code] || [])]);
const onlyLayout = msg => !/\p{L}/u.test(msg.replace(/\{\w+\}/g, ''));
// meta.* keys are settings of the language, not text: the same value in several languages is fine.
const META = { 'meta.fieldInSentence': ['lower', 'keep'] };

for (const code of LANGUAGES.filter(c => c !== 'en')) {
  const en = catalogs.en;
  const other = catalogs[code];

  test(`catalog ${code}: exactly the keys of en`, () => {
    assert.deepEqual(Object.keys(other).filter(k => !(k in en)), [], 'keys that en does not have');
    assert.deepEqual(Object.keys(en).filter(k => !(k in other)), [], 'keys missing from the catalog');
  });

  test(`catalog ${code}: same plural shapes as en, and the same placeholders in every form`, () => {
    for (const [key, source] of Object.entries(en)) {
      const msg = other[key];
      if (msg === undefined) continue;
      assert.equal(typeof msg, typeof source, `${key}: string or plural`);
      if (typeof source === 'object') {
        for (const form of ['one', 'other']) assert.equal(typeof msg[form], 'string', `${key}.${form}`);
        for (const form of Object.keys(msg)) assert.ok(['zero', 'one', 'two', 'few', 'many', 'other'].includes(form), `${key}.${form}`);
      }
      for (const [form, text] of formEntries(msg)) {
        assert.deepEqual(placeholders(text), placeholders(sourceForm(source, form)), `${key}${form && `.${form}`}: placeholders`);
      }
    }
  });

  test(`catalog ${code}: translated, except untranslatable words`, () => {
    const allowed = untranslated(code);
    for (const [key, source] of Object.entries(en)) {
      const msg = other[key];
      if (msg === undefined || key in META) continue;
      for (const [form, text] of formEntries(msg)) {
        const same = text === sourceForm(source, form) && !onlyLayout(text) && !allowed.has(text);
        assert.ok(!same, `${key}${form && `.${form}`} is still English: ${JSON.stringify(text)}`);
      }
    }
  });
}

test('catalogs: meta keys have one of their allowed values', () => {
  for (const code of LANGUAGES) {
    for (const [key, allowed] of Object.entries(META)) assert.ok(allowed.includes(catalogs[code][key]), `${code} ${key}: ${catalogs[code][key]}`);
  }
});

test('catalogs: no empty strings, and every plural has one and other', () => {
  for (const code of LANGUAGES) {
    for (const [key, msg] of Object.entries(catalogs[code])) {
      assert.ok(typeof msg === 'string' || (msg && typeof msg === 'object'), `${code} ${key}`);
      for (const form of forms(msg)) assert.ok(typeof form === 'string' && form.trim(), `${code} ${key} is empty`);
      if (typeof msg === 'object') assert.ok('one' in msg && 'other' in msg, `${code} ${key}`);
    }
  }
});

/* ---------- keys used in the code ---------- */

const fs = require('node:fs');
const path = require('node:path');
const SRC = path.join(__dirname, '..', 'src');
const sources = fs.readdirSync(SRC, { recursive: true }).filter(f => f.endsWith('.js') && !f.includes('locales')).map(f => [f, fs.readFileSync(path.join(SRC, f), 'utf8')]);
const NAMESPACES = 'person|field|change|status|stale|error|notify|menu|tray|theme|time|nav|sync|list|row|detail|notes|draft|settings|language|connect|help|toast|meta';

test('code: every literal key in t(…) exists in en', () => {
  const found = sources.flatMap(([file, text]) => [...text.matchAll(/\bt\(\s*(['"`])([^'"`$]+?)\1/g)].map(m => [file, m[2]]));
  assert.ok(found.length > 100, `only ${found.length} keys found: is the pattern still right?`);
  assert.deepEqual(found.filter(([, key]) => !(key in catalogs.en)).map(([file, key]) => `${file}: ${key}`), []);
});

test('code: every quoted key-shaped string exists in en (keys picked with a ternary or from a list)', () => {
  const missing = [];
  const pattern = new RegExp(`(['"\`])((?:${NAMESPACES})\\.[\\w.]+)\\1`, 'g');
  for (const [file, text] of sources) {
    for (const m of text.matchAll(pattern)) if (!(m[2] in catalogs.en) && !/\.(png|js|json|html|css)$/.test(m[2])) missing.push(`${file}: ${m[2]}`); // not file names such as tray.png
  }
  assert.deepEqual(missing, []);
});

test('code: every combination of a key built at runtime exists in en', () => {
  const { THEMES } = require('../src/shared/rules');
  const shortLines = ['comment', 'status', 'unassigned', 'assignedToYou', 'assigned', 'priority', 'description', 'summary', 'attachmentAdded', 'attachmentRemoved', 'field']; // shared/change.js shortLine
  const keys = [
    ...shortLines.flatMap(what => [`change.short.${what}`, `change.short.mine.${what}`]),
    ...['changed', 'tracked', 'stale', 'notes'].map(v => `nav.${v}`), // app.js list titles
    ...THEMES.map(value => `theme.${value}`), // main.js View → Theme, app.js theme picker
    ...['forbidden', 'notFound', 'rejected'].flatMap(k => [`error.jira.${k}`, `error.jira.${k}Detail`]), // jira.js toError with and without Jira's detail
  ];
  assert.deepEqual(keys.filter(k => !(k in catalogs.en)), []);
});
