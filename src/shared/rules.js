/* Small domain rules that main and renderer both know: note and project rules, intervals, themes,
 * the connected check, the choice of the default issue type and due dates. Shared between main (CommonJS) and renderer (classic script). */
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

  const pad = n => String(n).padStart(2, '0');
  /** The local calendar day of `date` as YYYY-MM-DD, the form of a Jira due date. */
  const localDay = (date = new Date()) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  /** A YYYY-MM-DD day as a day number (days since 1970-01-01), or null when it is no real date. */
  function dayNumber(day) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof day === 'string' ? day : '');
    if (!m) return null;
    const ms = Date.UTC(+m[1], m[2] - 1, +m[3]);
    return new Date(ms).getUTCDate() === +m[3] ? ms / 86_400_000 : null; // 2026-02-31 rolls over: not a date
  }
  /** Calendar days from `today` until `due` (both YYYY-MM-DD): negative when overdue, 0 when due today, null without a valid date. */
  function daysUntilDue(due, today) {
    const d = dayNumber(due), now = dayNumber(today);
    return d == null || now == null ? null : d - now;
  }
  /** The marker on a tracked issue's row: 'overdue' or 'today' for an unfinished issue, otherwise null. Being overdue is never a change. */
  function dueMarker(issue, today) {
    if (!issue || issue.statusCat === 'done') return null;
    const days = daysUntilDue(issue.due, today);
    return days == null || days > 0 ? null : days < 0 ? 'overdue' : 'today';
  }

  return { NOTE_MAX, INTERVALS, THEMES, noteText, projectKey, notesProjectOf, isConfigured, defaultIssueType, localDay, daysUntilDue, dueMarker };
});
