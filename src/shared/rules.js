/* Small domain rules that main and renderer both know: note and project rules, intervals, themes,
 * the connected check and the choice of the default issue type. Shared between main (CommonJS) and renderer (classic script). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./text'));
  else root.IssuemonRules = factory(root.IssuemonText);
})(typeof self !== 'undefined' ? self : this, function (shorten) {
  'use strict';

  const NOTE_MAX = 255; // a note becomes an issue's summary, and Jira summaries are at most 255 characters
  const INTERVALS = [5, 10, 15, 30, 60]; // minutes between two checks
  const THEMES = ['system', 'light', 'dark'];

  /** One line: whitespace (newlines too) becomes a single space, trimmed and cut off at NOTE_MAX (between grapheme clusters). */
  const oneLine = value => String(value || '').replace(/\s+/g, ' ').trim();
  const noteText = value => shorten.truncate(oneLine(value), NOTE_MAX);
  /** Project key: uppercase, only A-Z, digits and _. */
  const projectKey = value => String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
  /** Project for a new issue when none was chosen: the notes project, otherwise the default project (empty when neither is set). */
  const notesProjectOf = settings => projectKey(settings?.notesProject) || projectKey(settings?.defaultProject);
  /** Connected to Jira: URL, email address and API token are all three filled in. `hasToken`: main knows it from storage, the renderer from settings.hasToken. */
  const isConfigured = (settings, hasToken) => !!(settings?.baseUrl && settings?.email && hasToken);
  /** Type for a new issue from a list of standard types: Task (or its Dutch, French, German or Spanish name), otherwise the first. */
  const defaultIssueType = types => types.find(t => /^(task|taak|tâche|aufgabe|tarea)$/i.test(t.name)) || types[0] || null;

  return { NOTE_MAX, INTERVALS, THEMES, noteText, projectKey, notesProjectOf, isConfigured, defaultIssueType };
});
