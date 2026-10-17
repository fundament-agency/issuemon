/* One change in words, without HTML: field labels, the "you" rule, the notification line, the short sentence and the chip.
 * The words come from the translator `t` (shared/i18n.js; English by default).
 * Shared between main (CommonJS) and renderer (classic script). The timeline HTML stays in the renderer. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./i18n'));
  else root.IssuemonChange = factory(root.IssuemonI18n);
})(typeof self !== 'undefined' ? self : this, function (i18n) {
  'use strict';

  const EN = i18n.createTranslator('en');

  /** Our field name → catalog key of its label. Unknown fields keep Jira's own label. */
  const FIELD_LABELS = {
    status: 'field.status', assignee: 'field.assignee', priority: 'field.priority', summary: 'field.summary',
    description: 'field.description', labels: 'field.labels', fixVersion: 'field.fixVersion', attachment: 'field.attachment',
    resolution: 'field.resolution', sprint: 'field.sprint', duedate: 'field.duedate', issuetype: 'field.issuetype',
    reporter: 'field.reporter', key: 'field.key', comment: 'field.comment',
  };
  const fieldLabel = (c, t = EN) => (FIELD_LABELS[c.field] ? t(FIELD_LABELS[c.field]) : c.label || c.field);
  /** The field label inside a sentence ("Sam changed priority"): lower-cased only when the catalog's meta.fieldInSentence
      is 'lower'; 'keep' leaves it as is (German nouns keep their capital). */
  const fieldInSentence = (c, t = EN) => {
    const label = fieldLabel(c, t);
    return t('meta.fieldInSentence') === 'lower' ? label.toLocaleLowerCase(t.locale) : label;
  };
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const firstName = p => p.name.trim().split(/\s+/)[0];

  /** Whether two display names are the same person: trimmed and case-insensitive; an empty name never matches. */
  const sameName = (a, b) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

  /** Whether this change assigns the issue to `meName` (display name). Assignee changes carry only names, no account ids:
      comparing by name is the best signal there is. */
  const assignedToMe = (c, meName) => c.field === 'assignee' && sameName(c.to, meName);

  /** One line of plain text, for notifications. `me` is your display name. */
  function describe(c, { me, key = '', t = EN } = {}) {
    if (c.field === 'gone') return t('change.gone');
    const who = c.author?.name || t('person.someone');
    if (assignedToMe(c, me)) return t('change.describe.assignedToYou', { who });
    switch (c.field) {
      case 'comment':
        if (c.mentionsMe) return t('change.describe.mentionedYou', { who, key });
        return t(c.edited ? 'change.describe.commentEdited' : 'change.describe.comment', { who, text: clip(String(c.to || '').replace(/\s+/g, ' '), 110) });
      case 'description': return t('change.describe.description', { who });
      case 'attachment':
        if (c.to) return t('change.describe.attachmentAdded', { who, name: c.to });
        return c.from ? t('change.describe.attachmentRemoved', { who, name: c.from }) : t('change.describe.attachmentRemovedUnnamed', { who });
      default: {
        const empty = t('change.empty');
        return t('change.describe.field', { who, field: fieldLabel(c, t), from: c.from || empty, to: c.to || empty });
      }
    }
  }

  /** Short sentence about one change, such as "You commented" or "Sam set it to Done". `authorIsMe`: the author is you (determined by account id). */
  function shortLine(c, { me, authorIsMe, t = EN } = {}) {
    if (c.field === 'gone') return t('change.gone'); // nobody did it: no author, also not you
    const who = authorIsMe ? null : (c.author?.name?.trim() ? firstName(c.author) : t('person.someone'));
    const to = clip(c.to || t('change.empty'), 24);
    let what;
    switch (c.field) {
      case 'comment': what = c.edited ? 'commentEdited' : 'comment'; break;
      case 'status': what = 'status'; break;
      case 'assignee': what = !c.to ? 'unassigned' : assignedToMe(c, me) ? 'assignedToYou' : 'assigned'; break;
      case 'priority': what = 'priority'; break;
      case 'description': what = 'description'; break;
      case 'summary': what = 'summary'; break;
      case 'attachment': what = c.to ? 'attachmentAdded' : 'attachmentRemoved'; break;
      default: what = 'field';
    }
    // With you as the author the sentence is a message of its own: the verb differs per person in many languages.
    return t(`change.short.${authorIsMe ? 'mine.' : ''}${what}`, { who, to, field: fieldInSentence(c, t) });
  }

  /** Text of the chip for one change, and whether it is an assignment to you (that one stands out). */
  function chip(c, { me, t = EN } = {}) {
    if (c.field === 'comment' && c.mentionsMe) return { text: t('change.chip.mentionsYou'), mine: true };
    if (c.field === 'assignee') {
      if (assignedToMe(c, me)) return { text: t('change.chip.assignedToYou'), mine: true };
      return { text: c.to ? t('change.chip.assigned', { to: clip(c.to, 28) }) : t('change.chip.unassigned'), mine: false };
    }
    switch (c.field) {
      case 'gone': return { text: t('change.chip.gone'), mine: false };
      case 'description': return { text: t('change.chip.description'), mine: false };
      case 'attachment': return { text: t(c.to ? 'change.chip.attachmentAdded' : 'change.chip.attachmentRemoved'), mine: false };
      case 'summary': return { text: t('change.chip.summary'), mine: false };
      default: return { text: t('change.chip.field', { field: fieldLabel(c, t), to: clip(c.to || t('change.empty'), 28) }), mine: false };
    }
  }

  return { FIELD_LABELS, fieldLabel, fieldInSentence, clip, firstName, sameName, assignedToMe, describe, shortLine, chip };
});
