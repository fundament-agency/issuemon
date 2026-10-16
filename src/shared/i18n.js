/* Languages and translation: which catalogs exist, which language and locale to use, and the translator t(key, params).
 * No DOM, no Electron. Shared between main (CommonJS) and renderer (classic script); the catalogs live in locales/. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory({
      en: require('./locales/en'),
      nl: require('./locales/nl'),
      fr: require('./locales/fr'),
      de: require('./locales/de'),
      es: require('./locales/es'),
    });
  } else root.IssuemonI18n = factory(root.IssuemonLocales || {});
})(typeof self !== 'undefined' ? self : this, function (catalogs) {
  'use strict';

  const ORDER = ['en', 'nl', 'fr', 'de', 'es'];
  /** Codes of the registered catalogs, in the fixed order. */
  const LANGUAGES = ORDER.filter(code => catalogs[code]);
  /** Native names: never translated. */
  const LANGUAGE_NAMES = { en: 'English', nl: 'Nederlands', fr: 'Français', de: 'Deutsch', es: 'Español' };
  /** The allowed values of settings.language. */
  const LANGUAGE_SETTINGS = ['system', ...LANGUAGES];
  const DEFAULT_TAGS = { en: 'en-GB', nl: 'nl-NL', fr: 'fr-FR', de: 'de-DE', es: 'es-ES' };

  /** "nl_BE" → "nl-BE"; null for an empty or invalid tag. */
  function canonical(locale) {
    try {
      return Intl.getCanonicalLocales(String(locale || '').replace(/_/g, '-'))[0] || null;
    } catch {
      return null;
    }
  }
  const subtag = locale => (canonical(locale) || '').split('-')[0].toLowerCase();

  /** The language to show: a supported setting wins; otherwise ('system', missing, invalid) the system language if supported, else English. */
  function resolveLanguage(setting, systemLocale) {
    if (LANGUAGES.includes(setting)) return setting;
    const code = subtag(systemLocale);
    return LANGUAGES.includes(code) ? code : 'en';
  }

  /**
   * The system locale for resolveLanguage and localeTag. appLocale (app.getLocale()) is the best match among the Chromium
   * languages the app ships (electronLanguages in package.json), so a Mac in Italian gets en-US there. When macOS's first
   * language is not the one Chromium chose, that first language counts: an unsupported one then falls back to English with
   * en-GB dates, and never to a second macOS language.
   */
  function systemLocale(appLocale, preferredLanguages = []) {
    const first = preferredLanguages[0];
    return first && subtag(first) !== subtag(appLocale) ? first : appLocale;
  }

  /** BCP 47 tag for Intl and toLocale*: the system locale when it is in this language (so en-US keeps its dates), else the language default. */
  function localeTag(language, systemLocale) {
    const tag = canonical(systemLocale);
    if (tag && subtag(tag) === language) return tag;
    return DEFAULT_TAGS[language] || 'en-GB';
  }

  const interpolate = (msg, params) => msg.replace(/\{(\w+)\}/g, (_, name) => (params[name] == null ? '' : String(params[name])));

  /**
   * t(key, params): the message in `language`, else in English, else the key itself; never throws.
   * A plural message { one, other, … } is chosen with Intl.PluralRules on params.n. t.language, t.locale, t.has(key).
   */
  function createTranslator(language, systemLocale) {
    const lang = resolveLanguage(language, systemLocale);
    const rules = new Intl.PluralRules(lang);
    const lookup = key => catalogs[lang]?.[key] ?? catalogs.en?.[key];
    const t = (key, params = {}) => {
      let msg = lookup(key);
      if (msg == null) return key;
      if (typeof msg === 'object') msg = msg[rules.select(Number(params.n))] ?? msg.other;
      return interpolate(String(msg), params);
    };
    t.language = lang;
    t.locale = localeTag(lang, systemLocale);
    t.has = key => lookup(key) != null;
    return t;
  }

  return { LANGUAGES, LANGUAGE_NAMES, LANGUAGE_SETTINGS, resolveLanguage, systemLocale, localeTag, createTranslator, catalogs };
});
