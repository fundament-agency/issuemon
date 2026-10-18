'use strict';
/* IssueMon renderer — "Inbox" layout: navigation on the left, list in the middle, detail on the right.
 * All data comes from the main process via window.issuemon; only UI state lives here.
 * Keys: j/k or ↑/↓ browse, e = processed, o = open in Jira, u = stop tracking, / or ⌘K = paste field,
 * ⌘Z = undo, ⌥↑/⌥↓ = move a note, ? = shortcut overview, Esc = back or close. The menu accelerators in main
 * (⌘1–⌘4, ⌘, and ⌘L, plus ⌘Z from the menu) arrive via onCommand; ⌘R is handled in main itself. Outside macOS ⌘ is Ctrl
 * and ⌥ is Alt, also in the labels (MOD, ALT). */
(() => {
  const api = window.issuemon;
  const { parseKeys } = window.IssuemonKeys;
  const { wordDiff } = window.IssuemonDiff;
  const { UNASSIGNED, compute, settle, neighbour, pending, isChanged, isDone, fold, sortPeople } = window.IssuemonInbox;
  const { initials } = window.IssuemonText;
  const { clip, firstName, assignedToMe, fieldInSentence, shortLine, chip } = window.IssuemonChange;
  const { NOTE_MAX, INTERVALS, THEMES, noteText, projectKey, notesProjectOf, isConfigured, defaultIssueType, localDay, daysUntilDue, dueMarker } = window.IssuemonRules;
  const { LANGUAGES, LANGUAGE_NAMES, LANGUAGE_SETTINGS, createTranslator, resolveLanguage } = window.IssuemonI18n;
  document.documentElement.classList.add(`platform-${api.platform}`);
  const MAC = api.platform === 'darwin';
  const MOD = MAC ? '⌘' : 'Ctrl+', ALT = MAC ? '⌥' : 'Alt+'; // how this platform writes the modifier keys in shortcut labels
  const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
  const $ = sel => document.querySelector(sel);

  let S = null; // public state from main
  let t = null; // translator for settings.language (shared/i18n.js), made in receive()
  // Optimistic updates and Undo: see actions.js. apply works on S and is laid over S again after every push from main until the call is done.
  const actions = IssuemonActions.create({ getState: () => S });
  const rowReveal = IssuemonReveal.create();
  const UI = { view: 'changed', selected: null, detailOpen: false, addText: '', noteText: '', doneOpen: false, trackedQuery: '', peopleQuery: '', staleFilter: [], staleMenu: false, highlight: null, pendingSelect: null, reveal: null, conn: null, notifyBusy: false, updateBusy: false, updateFailed: false, draft: null, connectDraft: null, activity: {}, descOpen: {}, help: false };
  // UI.doneOpen: the Done group in Tracked is expanded; UI.trackedQuery: the text in the Tracked filter
  // UI.connectDraft: what you typed on the connect screen, { baseUrl, email, token }; survives a re-render from a state push
  // UI.draft: a note's open create panel, { id, summary, project, typeId, types, typesState, typesFor, typesError, error, creating }
  let drag = null; // the note being dragged: { id, li, list }

  /* ---------- derived state ---------- */

  // The list rules (what goes where, in what order, counts, selection) live in shared/inbox.js.
  // C is the computation of the render in progress: only the drawing functions (and render() for the title) read it;
  // everything else computes its own with inbox().
  const inbox = () => compute(S, UI, { locale: t.locale });
  let C = null;
  const find = key => S.tracked.find(x => x.key === key);
  const newestAt = cs => cs.reduce((m, c) => Math.max(m, c.at), 0);
  const byNewest = (a, b) => b.at - a.at;
  const lastProcessedAt = tr => tr.changes.reduce((m, c) => Math.max(m, c.processedAt || 0), 0);
  const configured = () => isConfigured(S.settings, S.settings.hasToken);
  const daysIdle = i => Math.floor((Date.now() - i.updated) / DAY);
  const idleCls = d => (d >= 30 ? 'hot' : d >= 21 ? 'warm' : '');
  const isMe = u => !!(u?.accountId && u.accountId === S.me?.accountId);
  const toMe = c => assignedToMe(c, S.me?.name) || (c.field === 'comment' && c.mentionsMe);
  const staleIssue = key => S.stale.issues.find(i => i.key === key);

  /* ---------- small render helpers ---------- */

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function rel(ts) {
    if (!ts) return t('time.never');
    const d = Date.now() - ts;
    if (d < 45e3) return t('time.justNow');
    if (d < HOUR) return t('time.minutesAgo', { n: Math.round(d / MIN) });
    if (d < DAY) return t('time.hoursAgo', { n: Math.round(d / HOUR) });
    const days = Math.floor(d / DAY);
    return days === 1 ? t('time.yesterday') : t('time.daysAgo', { n: days });
  }
  function relShort(ts) {
    const d = Date.now() - ts;
    if (d < 45e3) return t('time.short.justNow');
    if (d < HOUR) return t('time.short.minutes', { n: Math.round(d / MIN) });
    if (d < DAY) return t('time.short.hours', { n: Math.round(d / HOUR) });
    return t('time.short.days', { n: Math.floor(d / DAY) });
  }
  const fmtDate = ts => new Date(ts).toLocaleDateString(t.locale, { day: 'numeric', month: 'short', ...(new Date(ts).getFullYear() !== new Date().getFullYear() && { year: 'numeric' }) });
  /** A due date (YYYY-MM-DD, a calendar day) as a local date: "16 Oct", with the year when it is not this year. */
  const fmtDay = day => { const [y, m, d] = day.split('-').map(Number); return fmtDate(new Date(y, m - 1, d).getTime()); };
  const fmtTime = ts => new Date(ts).toLocaleString(t.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  const ICONS = {
    check: '<polyline points="20 6 9 17 4 12"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
    sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
    inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
    back: '<polyline points="15 18 9 12 15 6"/>',
    chevron: '<polyline points="6 9 12 15 18 9"/>',
    sort: '<path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="M11 4h10"/><path d="M11 8h7"/><path d="M11 12h4"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    msg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    alert: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
    sun: '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>',
    moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
    note: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
    grip: '<circle cx="9" cy="6" r=".6"/><circle cx="15" cy="6" r=".6"/><circle cx="9" cy="12" r=".6"/><circle cx="15" cy="12" r=".6"/><circle cx="9" cy="18" r=".6"/><circle cx="15" cy="18" r=".6"/>',
    search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  };
  const icon = (n, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n]}</svg>`;

  function statusCls(name, cat) {
    if (/block/i.test(name || '')) return 'blocked';
    if (cat) return { new: 'todo', indeterminate: 'prog', done: 'done' }[cat] || 'todo';
    if (/^(done|closed|live|resolved|gereed|klaar|afgerond)/i.test(name || '')) return 'done';
    if (/^(to ?do|open|backlog|new|nieuw|selected)/i.test(name || '')) return 'todo';
    return 'prog';
  }
  const pill = (name, cat) => `<span class="pill ${statusCls(name, cat)}">${esc(name || '—')}</span>`;
  const issuePill = i => pill(i.status, i.statusCat);

  function typeCls(i) {
    const ty = (i.type || '').toLowerCase();
    if (i.subtask || /sub/.test(ty)) return 'subtask';
    if (/bug|defect|incident/.test(ty)) return 'bug';
    if (/story|verhaal/.test(ty)) return 'story';
    if (/epic/.test(ty)) return 'epic';
    if (/task|taak/.test(ty)) return 'task';
    return 'other';
  }
  const typeIcon = i => `<span class="type ${typeCls(i)}" title="${esc(i.type)}"></span>`;

  const PRIO_GLYPH = { highest: '⇈', high: '↑', medium: '=', low: '↓', lowest: '⇊' };
  const prio = p => `<span class="prio p-${esc((p || '').toLowerCase())}" title="${esc(t('detail.priorityTitle', { priority: p || t('detail.priorityNone') }))}">${PRIO_GLYPH[(p || '').toLowerCase()] || '•'}</span>`;

  function hue(name) { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
  /** `nobody`: the key for a missing user, "Unassigned" for an assignee; authors use authorAvatar. */
  function avatar(u, cls = '', nobody = 'person.unassigned') {
    const name = u?.name;
    if (!name) return `<span class="avatar none ${cls}" title="${esc(t(u == null ? nobody : 'person.unknown'))}">–</span>`;
    const ini = initials(name);
    return `<span class="avatar ${isMe(u) ? 'me' : ''} ${cls}" style="--h:${hue(name)}" title="${esc(name)}">${esc(ini)}</span>`;
  }
  /** The author of a change: none (a change found by comparing snapshots) is "Someone", not "Unassigned". */
  const authorAvatar = (u, cls) => avatar(u, cls, 'person.someone');
  /** No user is "Unassigned"; a user without a name is "Unknown". */
  const personName = u => (u ? u.name || t('person.unknown') : t('person.unassigned'));
  const person = u => `${avatar(u, 'xs')}<span>${esc(personName(u))}${isMe(u) ? ` ${esc(t('person.youSuffix'))}` : ''}</span>`;
  /** Whose issues, as HTML: "assigned to you", "assigned to Sam Rivera", "assigned to you and Sam Rivera", "assigned to 3 people" */
  function onNameOf(people) {
    if (!people.length || (people.length === 1 && isMe(people[0]))) return esc(t('stale.whose.mine'));
    if (people.length > 2) return esc(t('stale.whose.many', { n: people.length })); // exactly who is shown in the filter menu
    const [a, b] = people.map(p => (isMe(p) ? esc(t('person.youObject')) : esc(p.name)));
    return b ? t('stale.whose.two', { a, b }) : t('stale.whose.one', { name: a });
  }

  /** The short sentence for the subline of a quiet row, such as "You commented" or "Sam set it to Done". */
  const chShort = c => shortLine(c, { me: S.me?.name, authorIsMe: !!c.own || isMe(c.author), t });

  // Summary of pending changes as chips: new and edited comments counted apart, per field only the newest.
  function changeChips(cs) {
    const seen = new Set();
    const out = [];
    const comments = cs.filter(c => c.field === 'comment' && !c.edited).length;
    const edited = new Set(cs.filter(c => c.field === 'comment' && c.edited).map(c => String(c.id).split('@')[0])).size; // per comment, however often edited
    const mention = cs.find(c => c.field === 'comment' && c.mentionsMe);
    if (mention) out.push(`<span class="chip me">${esc(chip(mention, { t }).text)}</span>`);
    if (comments) out.push(`<span class="chip">${icon('msg')}${esc(t('row.comments', { n: comments }))}</span>`);
    if (edited) out.push(`<span class="chip">${icon('msg')}${esc(t('row.commentsEdited', { n: edited }))}</span>`);
    for (const c of [...cs].sort(byNewest)) {
      const k = c.field === 'other' ? `other:${c.label}` : c.field;
      if (c.field === 'comment' || seen.has(k)) continue;
      seen.add(k);
      const { text, mine } = chip(c, { me: S.me?.name, t });
      out.push(`<span class="chip ${mine ? 'me' : ''}">${esc(text)}</span>`);
    }
    return out.join('');
  }

  /** Only stored ranges from actual mention nodes can highlight text; escape every fragment, including the mention. */
  function mentionHtml(text, mentions = [], offset = 0) {
    let at = 0;
    let html = '';
    const ranges = (Array.isArray(mentions) ? mentions : []).filter(m =>
      S.me?.accountId && m.accountId === S.me.accountId && Number.isInteger(m.start) && Number.isInteger(m.end) && m.start >= 0 && m.end > m.start,
    ).sort((a, b) => a.start - b.start);
    for (const m of ranges) {
      const start = Math.max(0, m.start - offset), end = Math.min(text.length, m.end - offset);
      if (start < at || start >= end) continue;
      html += `${esc(text.slice(at, start))}<mark class="mention-me">${esc(text.slice(start, end))}</mark>`;
      at = end;
    }
    return html + esc(text.slice(at));
  }

  const DIFF_KEEP = 12; // words of unchanged text you see on each side of a change
  /** A long unchanged stretch shortened to the words next to the changes, with a "…" in between. */
  function sameHtml(text, first, last) {
    const words = text.match(/\s*\S+\s*|\s+/g) || [];
    const keep = first || last ? DIFF_KEEP : 2 * DIFF_KEEP;
    if (words.length <= keep + 2) return esc(text);
    const hidden = words.length - keep;
    const gap = `<span class="gap" title="${esc(t('detail.diffGap', { n: hidden }))}">…</span>`;
    if (first) return `${gap} ${esc(words.slice(-DIFF_KEEP).join(''))}`;
    if (last) return `${esc(words.slice(0, DIFF_KEEP).join(''))}${gap}`;
    return `${esc(words.slice(0, DIFF_KEEP).join(''))}${gap} ${esc(words.slice(-DIFF_KEEP).join(''))}`;
  }
  /** Description (and an edited comment whose old text is known): marked word by word; if nothing is shared, the old and new text one below the other; only whitespace changed gets a note. */
  function descDiffHtml(from, to, mentions = []) {
    // A mention target can change while the visible text stays identical.
    if (from === to) return `<blockquote>${mentionHtml(to || '', mentions)}</blockquote>`;
    const parts = wordDiff(from || '', to || '');
    if (parts.length && parts.every(p => p.type === 'same' || !p.text.trim())) return `<p class="va-note muted">${esc(t('detail.diffWhitespace'))}</p>${mentions.length ? `<blockquote>${mentionHtml(to || '', mentions)}</blockquote>` : ''}`;
    const empty = `(${t('change.empty')})`;
    if (parts.every(p => p.type !== 'same')) return `<div class="diff"><del>${esc(from || empty)}</del><ins>${mentionHtml(to || empty, mentions)}</ins></div>`;
    let offset = 0;
    const html = parts.map((p, i) => {
      const text = p.type === 'del' ? esc(p.text) : mentionHtml(p.text, mentions, offset);
      if (p.type !== 'del') offset += p.text.length;
      return p.type === 'same'
        ? (mentions.length ? text : sameHtml(p.text, i === 0, i === parts.length - 1))
        : `<${p.type}>${text}</${p.type}>`;
    });
    return `<div class="diff inline">${html.join('')}</div>`;
  }
  // A change's diff never changes, but chHtml runs on every render: memoize per change id (the last 100). Cleared on a language change.
  const diffMemo = new Map();
  function descDiffCached(c) {
    const mentions = c.field === 'comment' ? c.mentions || [] : [];
    if (!c.id) return descDiffHtml(c.from, c.to, mentions);
    const cacheKey = `${c.id}:${S.me?.accountId || ''}`;
    let html = diffMemo.get(cacheKey);
    if (html === undefined) {
      html = descDiffHtml(c.from, c.to, mentions);
      diffMemo.set(cacheKey, html);
      if (diffMemo.size > 100) diffMemo.delete(diffMemo.keys().next().value);
    }
    return html;
  }

  /** [head, body] of one change in the timeline. The change.timeline.* params (who, from, to, name) are HTML: escape them here. */
  function chHtml(c) {
    const who = `<b>${esc(c.author?.name || t('person.someone'))}</b>`;
    const from = c.from ? `<span class="from">${esc(clip(c.from, 120))}</span>` : '';
    switch (c.field) {
      case 'gone': return [`<span class="err-text">${esc(t('change.gone'))}</span>`, ''];
      case 'comment':
        if (!c.edited) return [t('change.timeline.comment', { who }), `<blockquote>${mentionHtml(c.to || '', c.mentions)}</blockquote>`];
        // An edit: word by word when IssueMon recorded the old text, else just the new text
        return [t('change.timeline.commentEdited', { who }), c.from != null ? descDiffCached(c) : `<blockquote>${mentionHtml(c.to || '', c.mentions)}</blockquote>`];
      case 'description': return [t('change.timeline.description', { who }), descDiffCached(c)];
      case 'attachment': return [c.to
        ? t('change.timeline.attachmentAdded', { who, name: `<b>${esc(c.to)}</b>` })
        : t('change.timeline.attachmentRemoved', { who, name: `<span class="from">${esc(c.from)}</span>` }), ''];
      case 'status': return [t('change.timeline.status', { who, from: pill(c.from), to: pill(c.to) }), ''];
      case 'assignee': {
        if (!c.to) return [c.from ? t('change.timeline.unassignedFrom', { who, from: `<span class="from">${esc(c.from)}</span>` }) : t('change.timeline.unassigned', { who }), ''];
        const mine = toMe(c);
        const to = `<span class="to ${mine ? 'me' : ''}">${esc(mine ? t('person.youObject') : c.to)}</span>`;
        if (mine) return [c.from ? t('change.timeline.reassignedToYou', { who, from, to }) : t('change.timeline.assignedToYou', { who, to }), ''];
        return [c.from ? t('change.timeline.reassigned', { who, from, to }) : t('change.timeline.assigned', { who, to }), ''];
      }
      default: {
        const field = esc(fieldInSentence(c, t));
        const to = `<span class="to">${esc(clip(c.to || t('change.empty'), 160))}</span>`;
        return [c.from ? t('change.timeline.fieldFrom', { who, field, from, to }) : t('change.timeline.field', { who, field, to }), ''];
      }
    }
  }
  function timeline(cs) {
    return `<ol class="tl">${[...cs].sort(byNewest).map(c => {
      const [head, body] = chHtml(c);
      const own = c.own ? ` <span class="own-tag" title="${esc(t('detail.ownTagTitle'))}">${esc(t('detail.ownTag'))}</span>` : '';
      return `<li class="tl-i ${c.processed ? 'done' : ''}">${authorAvatar(c.author)}<div class="tl-b"><div class="tl-h"><span>${head}${own}</span><time title="${fmtTime(c.at)}">${rel(c.at)}</time></div>${body}</div></li>`;
    }).join('')}</ol>`;
  }
  /** The due date, and for an unfinished issue how far away it is: "in 3 days", "today" or "2 days overdue". */
  function dueHtml(i) {
    const days = daysUntilDue(i.due, localDay());
    if (days == null) return '';
    const when = i.statusCat === 'done' ? ''
      : days > 0 ? t('detail.dueIn', { n: days }) : days === 0 ? t('detail.dueToday') : t('detail.overdue', { n: -days });
    const cls = dueMarker(i, localDay()) || '';
    return `<div><dt>${esc(t('detail.due'))}</dt><dd class="meta-due ${cls}">${esc(fmtDay(i.due))}${when ? ` · ${esc(when)}` : ''}</dd></div>`;
  }
  /** The Overdue or Due today marker on the row of a tracked issue that is not done. */
  function dueMark(i) {
    const mark = dueMarker(i, localDay());
    return mark ? `<span class="due-mark ${mark}">${esc(t(mark === 'overdue' ? 'row.overdue' : 'row.dueToday'))}</span>` : '';
  }
  /** `updated: false` leaves out "Last updated", for panes that already show the age elsewhere; `due: false` the due date. */
  function metaGrid(i, { updated = true, due = true } = {}) {
    return `<dl class="meta">
      <div><dt>${esc(t('field.status'))}</dt><dd>${issuePill(i)}</dd></div>
      <div><dt>${esc(t('field.assignee'))}</dt><dd>${person(i.assignee)}</dd></div>
      <div><dt>${esc(t('field.priority'))}</dt><dd>${prio(i.priority)}<span>${esc(i.priority || t('detail.noPriority'))}</span></dd></div>
      ${(i.labels || []).length ? `<div><dt>${esc(t('field.labels'))}</dt><dd class="meta-labels">${i.labels.map(label => `<span class="chip">${esc(label)}</span>`).join('')}</dd></div>` : ''}
      ${(i.fixVersions || []).length ? `<div><dt>${esc(t('field.fixVersion'))}</dt><dd class="meta-versions">${esc(i.fixVersions.join(', '))}</dd></div>` : ''}
      ${due ? dueHtml(i) : ''}
      ${updated ? `<div><dt>${esc(t('detail.lastUpdated'))}</dt><dd><span title="${i.updated ? fmtTime(i.updated) : ''}">${rel(i.updated)}</span></dd></div>` : ''}
    </dl>`;
  }

  function relationsHtml(i) {
    const row = (issue, type = '', summary = true) => `<li>${type ? `<span>${esc(type)}</span> ` : ''}<button class="linkish" data-action="related" data-key="${esc(issue.key)}">${esc(issue.key)}</button>${summary && issue.summary ? ` <span>${esc(issue.summary)}</span>` : ''} · ${issuePill(issue)}</li>`;
    const section = (kind, title, rows) => `<section class="va-relations" data-relations="${kind}"><h3 class="va-sec">${esc(title)}</h3><ul>${rows}</ul></section>`;
    const subtasks = i.subtasks || [], links = i.links || [];
    return (i.parent ? section('parent', t('detail.parent'), row(i.parent)) : '')
      + (subtasks.length ? section('subtasks', t('detail.subtasks', { done: subtasks.filter(s => s.statusCat === 'done').length, total: subtasks.length }), subtasks.map(s => row(s)).join('')) : '')
      + (links.length ? section('links', t('detail.links'), links.map(l => row(l.issue, l.type || t('detail.related'), false)).join('')) : '');
  }

  /** Description of a tracked issue; texts over DESC_LONG characters stay collapsed until "More". */
  const DESC_LONG = 400;
  function descriptionHtml(i) {
    const text = (i.description || '').trim();
    if (!text) return '';
    const long = text.length > DESC_LONG;
    const open = !!UI.descOpen[i.key];
    return `<h3 class="va-sec">${esc(t('field.description'))}</h3>
      <div class="va-desc ${long && !open ? 'clamp' : ''}">${esc(text)}</div>
      ${long ? `<button class="btn ghost va-desc-toggle" data-action="toggle-desc" data-key="${esc(i.key)}">${esc(t(open ? 'detail.less' : 'detail.more'))}</button>` : ''}`;
  }

  /* Last comment and change per issue. Main decides how fresh the answer is; UI.activity[key] is only the
     latest answer, so the block can render synchronously (a skeleton until there is one). Every render of the
     block plans a request to main, which answers from its cache. We only update the block on a different
     fetchedAt or ok/error; until then the old answer stays. The request goes out ACTIVITY_DELAY ms after the
     first render for that issue, and only if its block is still on screen, so j/k through a list doesn't cost
     a request per row. */
  const ACTIVITY_DELAY = 300;
  let activityTimer = null, activityPlanned = null;
  function planActivity(key) {
    if (activityPlanned === key) return;
    clearTimeout(activityTimer);
    activityPlanned = key;
    activityTimer = setTimeout(() => {
      activityPlanned = null;
      if ([...document.querySelectorAll('[data-activity]')].some(el => el.dataset.activity === key)) fetchActivity(key);
    }, ACTIVITY_DELAY);
  }
  function fetchActivity(key) {
    api.activity(key).catch(err => ({ ok: false, error: err.message })).then(r => {
      const old = UI.activity[key];
      if (old && old.ok === r.ok && old.fetchedAt === r.fetchedAt) return;
      UI.activity[key] = r;
      // Only update this block: a full render would interrupt a running scroll animation or input.
      document.querySelectorAll('[data-activity]').forEach(el => { if (el.dataset.activity === key) el.innerHTML = activityInner(key); });
    });
  }
  function activityInner(key) {
    const a = UI.activity[key];
    if (!a) return '<div class="skel"></div>';
    if (!a.ok) return `<p class="va-note muted">${esc(t('detail.activityFailed'))}</p>`;
    const items = [];
    if (a.comment) items.push({ id: 'last-comment', at: a.comment.at, author: a.comment.author, field: 'comment', label: 'Comment', from: null, to: a.comment.text });
    if (a.change) items.push({ id: 'last-change', ...a.change });
    if (!items.length) return `<p class="va-note muted">${esc(t('detail.activityNone'))}</p>`;
    return `<div class="va-activity">${timeline(items)}</div>`;
  }
  function activityHtml(key) {
    planActivity(key);
    return `<h3 class="va-sec">${esc(t('detail.latestActivity'))}</h3><div data-activity="${esc(key)}">${activityInner(key)}</div>`;
  }

  function addPreviewHtml(text) {
    if (!text || !text.trim()) return '';
    const keys = parseKeys(text, S.settings.defaultProject);
    if (!keys.length) {
      const example = S.settings.defaultProject ? t('list.addExampleNumber', { key: 'ABC-123', number: '123' }) : t('list.addExample', { key: 'ABC-123' });
      return `<span class="ap warn">${esc(t('list.addNoKey'))}</span><span class="ap hint">${esc(example)}</span>`;
    }
    return keys.map(k => (find(k) ? `<span class="ap dup">${esc(t('list.addDuplicate', { key: k }))}</span>` : `<span class="ap ok">${k}</span>`)).join('') + `<span class="ap hint">${esc(t('list.addEnter', { key: 'Enter' }))}</span>`;
  }
  const syncLast = () => `<span data-last>${rel(S.status.lastCheck)}</span>`;
  const NEXT = '<span data-next></span>'; // countdown to the next check, filled in by tick()

  /* ---------- layout ---------- */

  const NAV = [ // label: catalog key, also the list title
    { id: 'changed', label: 'nav.changed', icon: 'inbox', count: () => C.counts.changed, hot: true },
    { id: 'tracked', label: 'nav.tracked', icon: 'eye', count: () => C.counts.tracked },
    { id: 'stale', label: 'nav.stale', icon: 'clock', count: () => C.counts.stale },
    { id: 'notes', label: 'nav.notes', icon: 'note', count: () => C.counts.notes },
    { id: 'settings', label: 'nav.settings', icon: 'sliders' },
  ];
  const wide = () => matchMedia('(min-width: 721px)').matches;
  const isPage = v => v === 'settings' || v === 'notes' || v === 'connect'; // full width, without list and detail

  /** Shortcut overview: [keys, description (a function: words come from t at render time), separator between the keys (default '/')]. */
  const SHORTCUTS = [
    [['j', 'k', '↑', '↓'], () => t('help.browse')],
    [['e'], () => t('help.processed')],
    [['o'], () => t('detail.openInJira')],
    [['u'], () => t('detail.untrack')],
    [['/', `${MOD}K`], () => t('help.paste'), () => t('help.or')],
    [[`${MOD}L`], () => t('help.viaMenu')],
    [[`${MOD}R`], () => t('sync.checkNow')],
    [[`${MOD}1`, `${MOD}4`], () => ['nav.changed', 'nav.tracked', 'nav.stale', 'nav.notes'].map(k => t(k)).join(', '), () => '–'],
    [[`${MOD},`], () => t('nav.settings')],
    [[`${MOD}Z`], () => t('toast.undo')],
    [['Esc'], () => t('help.back')],
    [[`${ALT}↑`, `${ALT}↓`], () => t('help.moveNote')],
    [['?'], () => t('help.thisList')],
  ];

  const helpOverlay = () => !UI.help ? '' : `<div class="help-backdrop" data-action="help-close"></div>
    <div class="help" role="dialog" aria-modal="true" aria-labelledby="help-title">
      <div class="help-head"><h2 id="help-title">${esc(t('help.title'))}</h2>
        <button class="btn icon ghost" data-action="help-close" title="${esc(t('help.close'))} (Esc)" aria-label="${esc(t('help.close'))}">${icon('x')}</button></div>
      <dl>${SHORTCUTS.map(([keys, what, sep = () => '/']) => `<dt>${keys.map(k => `<kbd>${k}</kbd>`).join(` ${esc(sep())} `)}</dt><dd>${esc(what())}</dd>`).join('')}</dl>
    </div>`;

  function draw() {
    const v = UI.view;
    C = inbox();
    return `<div class="va ${UI.detailOpen && UI.selected ? 'detail-open' : ''} ${isPage(v) ? 'is-page' : ''}">
      ${side()}
      ${v === 'settings' ? settingsPage() : v === 'notes' ? notesPage() : v === 'connect' ? connectPage() : list(v) + detail(v)}
    </div>${helpOverlay()}`;
  }

  function syncBlock() {
    const st = S.status;
    if (st.state === 'unconfigured' || !configured()) {
      return `<div class="va-sync-txt"><span class="live off"></span><span>${esc(t('sync.notConnected'))}</span></div>
        <button class="btn sm" data-action="view" data-view="connect" title="${esc(t('connect.connect'))}">${icon('sliders')}<span>${esc(t('connect.connect'))}</span></button>`;
    }
    const checking = st.state === 'checking';
    return `${st.state === 'error'
      ? `<div class="va-sync-txt"><span class="live err"></span><span>${esc(t('sync.failed'))}</span></div><div class="va-sync-msg" title="${esc(st.message)}">${esc(st.message)}</div>`
      : `<div class="va-sync-txt"><span class="live ${checking ? 'busy' : ''}"></span><span>${checking ? esc(t('sync.checking')) : t('sync.checked', { when: syncLast() })}</span></div>`}
      ${st.nextCheck && !checking ? `<div class="va-sync-txt muted"><span>${t(st.state === 'error' ? 'sync.nextRetry' : 'sync.nextCheck', { time: NEXT })}</span></div>` : ''}
      <div class="va-sync-btns">
        <button class="btn sm" data-action="check" title="${esc(t('sync.checkNow'))} (${MOD}R)" ${checking ? 'disabled' : ''}>${icon('refresh', checking ? 'spin' : '')}<span>${esc(t('sync.checkNow'))}</span></button>
        <button class="btn sm icon ghost" data-action="help" title="${esc(t('help.title'))} (?)" aria-label="${esc(t('help.title'))}">?</button>
      </div>`;
  }

  const failed = () => S.status.state === 'error' && configured();

  /** Error of the last check, at the top of every list. Retrying doesn't help with a login error: then it links to Settings. */
  const checkError = () => !failed() ? '' : `<div class="banner err">${icon('alert')}<span>${esc(t('sync.failedBanner', { message: S.status.message }))}</span>
    ${S.status.code === 'auth'
      ? `<button class="btn sm" data-action="view" data-view="settings">${esc(t('sync.toSettings'))}</button>`
      : `<button class="btn sm" data-action="check">${esc(t('sync.retry'))}</button>`}</div>`;

  const side = () => `<aside class="va-side">
    <nav class="va-nav">${NAV.map(n => {
      const c = n.count?.();
      const label = esc(t(n.label));
      return `<button class="${UI.view === n.id ? 'on' : ''}" data-action="view" data-view="${n.id}" title="${label}">
        ${icon(n.icon)}<span class="lbl">${label}</span>${c != null ? `<span class="count ${n.hot && c ? 'hot' : ''}">${c}</span>` : ''}
      </button>`;
    }).join('')}</nav>
    <div class="va-sync">${syncBlock()}</div>
  </aside>`;

  function list(v) {
    const keys = C.keys;
    const changedCount = C.counts.changed;
    const checking = S.status.state === 'checking';
    let intro;
    if (v === 'stale') {
      const ex = S.settings.excluded;
      const { filter: f, people, unassigned } = C.stale;
      const shown = f.length ? people.filter(p => f.includes(p.accountId)) : people;
      const nobody = unassigned && (!f.length || f.includes(UNASSIGNED)); // issues without an assignee are in the selection
      const whose = !nobody ? onNameOf(shown) : shown.length ? t('stale.whose.orUnassigned', { whose: onNameOf(shown) }) : esc(t('stale.whose.unassigned'));
      const n = keys.length;
      // Whole sentences; whose and count are HTML. Before the first fetch there is no count and the sentence starts with whose.
      const params = { n, whose, days: esc(t('stale.days', { n: S.settings.staleDays })), statuses: esc(ex.join(' / ')) };
      const hint = S.stale.fetchedAt
        ? t(ex.length ? 'stale.introExcluding' : 'stale.intro', { ...params, count: `<b>${esc(t('stale.count', { n, plus: S.stale.truncated ? '+' : '' }))}</b>` })
        : t(ex.length ? 'stale.introPendingExcluding' : 'stale.introPending', { ...params, whose: whose[0].toLocaleUpperCase(t.locale) + whose.slice(1) });
      intro = `<p class="va-hint">${hint}${S.stale.truncated ? ` ${esc(t('stale.truncated', { n: S.stale.issues.length }))}` : ''}${S.stale.fetchedAt ? ` ${esc(t('stale.updated', { when: rel(S.stale.fetchedAt) }))}` : ''}</p>
        ${S.stale.warning ? `<div class="banner warn">${icon('alert')}<span>${esc(S.stale.warning)}</span></div>` : ''}
        ${S.stale.error ? `<div class="banner err">${icon('alert')}<span>${esc(S.stale.error)}</span></div>` : ''}`;
    } else {
      intro = `<form class="va-add" data-form="add">
        <div class="va-add-field">${icon('plus')}<input id="add-input" type="text" data-add-input autocomplete="off" spellcheck="false" placeholder="${esc(t('list.addPlaceholder'))}" value="${esc(UI.addText)}"><kbd>/</kbd></div>
        <div class="add-preview" data-add-preview>${addPreviewHtml(UI.addText)}</div>
      </form>${v === 'tracked' && C.tracked.filterShown ? `<div class="va-add-field va-filter">${icon('search')}<input id="tracked-filter" type="text" data-tracked-filter autocomplete="off" spellcheck="false" aria-label="${esc(t('list.filterPlaceholder'))}" placeholder="${esc(t('list.filterPlaceholder'))}" value="${esc(UI.trackedQuery)}"></div>` : ''}`;
    }
    const body = !configured() && v !== 'stale' && !S.tracked.length ? onboarding()
      : v === 'tracked' ? trackedBody()
      : keys.length ? keys.map(k => (v === 'stale' ? staleRow(k) : trackedRow(k))).join('')
      : emptyList(v);
    return `<section class="va-list">
      <header class="va-list-head">
        <div class="va-list-title">
          <h1>${esc(t(`nav.${v}`))}</h1>
          ${v === 'stale' ? `<button class="btn sm ghost" data-action="stale-sort" title="${esc(t('stale.sortTitle'))}">${icon('sort')}${esc(t(S.settings.staleSort === 'oldest' ? 'stale.oldestFirst' : 'stale.newestFirst'))}</button>${staleFilterMenu()}` : ''}
          ${v === 'changed' && changedCount > 1 ? `<button class="btn sm ghost" data-action="mark-all">${esc(t('list.markAll'))}</button>` : ''}
          <button class="btn icon ghost va-m-only" data-action="check" title="${esc(t('sync.checkNow'))}">${icon('refresh', checking ? 'spin' : '')}</button>
        </div>
        <div class="va-m-only va-m-sync">${S.status.state === 'error' ? `<span class="err-text">${esc(S.status.message)}</span>` : `${t('sync.checked', { when: syncLast() })}${S.status.nextCheck ? ` · ${t('sync.nextShort', { time: NEXT })}` : ''}`}</div>
        ${checkError()}
        ${intro}
      </header>
      <div class="va-rows" data-scroll-key="rows">${body}</div>
    </section>`;
  }

  const onboarding = () => `<div class="va-onboard">
    <h2>${esc(t('connect.title'))}</h2>
    <ol>
      <li>${t('list.onboard1', { link: '<button class="linkish" data-action="token-page">id.atlassian.com</button>' })}</li>
      <li>${esc(t('list.onboard2'))}</li>
      <li>${esc(t('list.onboard3'))}</li>
    </ol>
    <button class="btn primary" data-action="view" data-view="connect">${icon('sliders')}${esc(t('connect.connect'))}</button>
  </div>`;

  /** "The last check failed …", with the countdown to the next attempt on a line of its own. */
  const failedMaybe = () => `${esc(t('list.failedMaybeChanges'))}${S.status.nextCheck ? `<br>${t('list.nextRetry', { time: NEXT })}` : ''}`;

  function emptyList(v) {
    if (v === 'changed' && configured() && !S.tracked.length) return `<div class="va-empty-list">${esc(t('list.noneTracked'))}<br>${esc(t('list.noneTrackedHint'))}</div>`;
    if (v === 'changed' && failed()) return `<div class="va-empty-list">${failedMaybe()}</div>`;
    if (v === 'changed') return `<div class="va-empty-list">${esc(t('list.noChanges'))}</div>`;
    if (v === 'tracked' && C.tracked.query) return `<div class="va-empty-list">${t('list.nothingFound', { query: esc(UI.trackedQuery.trim()) })}</div>`;
    if (v === 'tracked') return `<div class="va-empty-list">${esc(t('list.trackingNothing'))}</div>`;
    if (!configured()) return `<div class="va-empty-list">${esc(t('stale.connectFirst'))}<br><button class="btn sm" data-action="view" data-view="connect">${esc(t('connect.connect'))}</button></div>`;
    if (!S.stale.fetchedAt) return `<div class="va-empty-list">${S.status.state === 'checking' ? esc(t('stale.fetching')) : t('stale.notFetched', { button: `<button class="linkish" data-action="check">${esc(t('sync.checkNow'))}</button>` })}</div>`;
    return `<div class="va-empty-list">${esc(t(C.stale.filter.length && S.stale.issues.length ? 'stale.noneForSelection' : 'stale.none'))}</div>`;
  }

  /** Tracked: changed and active first, then the Done group (collapsed unless you open it or filter). */
  function trackedBody() {
    const g = C.tracked;
    if (!g.active.length && !g.done.length) return emptyList('tracked');
    const open = g.doneOpen;
    // Two buttons side by side: a button inside a button is invalid HTML.
    const head = g.done.length ? `<div class="va-group ${open ? 'open' : ''}">
      <button id="done-toggle" class="va-group-toggle" data-action="toggle-done" aria-expanded="${open}">${icon('chevron')}<span>${esc(t('list.doneGroup', { n: g.done.length }))}</span></button>
      <button id="done-stop" class="btn sm ghost" data-action="untrack-done" title="${esc(t('list.stopAllTitle'))}">${esc(t('list.stopAll'))}</button>
    </div>` : '';
    return g.active.map(x => trackedRow(x.key)).join('') + head + (open ? g.done.map(x => trackedRow(x.key)).join('') : '');
  }

  // Quiet row: the newest recorded change, or (nothing changed since tracking) who has it and when it was updated.
  // The time sits on the right in both cases.
  function quietSub(tr) {
    const last = [...(tr.changes || [])].sort(byNewest)[0];
    if (!last) return `<div class="va-row-sub">${person(tr.issue.assignee)}<span class="va-time">${relShort(tr.issue.updated)}</span></div>`;
    return `<div class="va-row-sub">${authorAvatar(last.author, 'xs')}<span>${esc(chShort(last))}</span><span class="va-time">${relShort(last.at)}</span></div>`;
  }

  function trackedRow(key) {
    const tr = find(key);
    if (tr.loading) return `<div class="va-row loading"><span class="va-dot"></span><div class="va-row-main"><div class="va-row-top"><span class="key">${esc(key)}</span><span class="muted">${esc(t('row.loading'))}</span></div><div class="skel"></div></div></div>`;
    const sel = UI.selected === key ? 'sel' : '';
    const hl = UI.highlight === key ? 'hl' : '';
    if (!tr.issue || tr.error) {
      return `<div class="va-row err ${sel}" data-action="select" data-key="${esc(key)}" data-row="${esc(key)}" tabindex="0">
        <span class="va-dot"></span>
        <div class="va-row-main"><div class="va-row-top"><span class="key">${esc(key)}</span></div>
        <div class="va-row-sum">${esc(tr.error || t('row.notFetched'))}</div></div></div>`;
    }
    const i = tr.issue, p = pending(tr);
    return `<div class="va-row ${sel} ${p.length ? 'unread' : ''} ${p.some(toMe) ? 'mine' : ''} ${hl}" data-action="select" data-key="${esc(key)}" data-row="${esc(key)}" tabindex="0">
      <span class="va-dot"></span>
      <div class="va-row-main">
        <div class="va-row-top">${typeIcon(i)}<span class="key">${esc(key)}</span>${issuePill(i)}${dueMark(i)}<span class="va-time">${p.length ? relShort(newestAt(p)) : ''}</span></div>
        <div class="va-row-sum">${esc(i.summary)}</div>
        ${p.length ? `<div class="chips">${changeChips(p)}</div>` : quietSub(tr)}
      </div>
      ${isDone(tr) ? `<button class="btn icon sm ghost va-row-stop" data-action="untrack" data-key="${esc(key)}" title="${esc(t('detail.untrack'))}" aria-label="${esc(t('row.untrackLabel', { key }))}">${icon('eyeOff')}</button>` : ''}
    </div>`;
  }

  /** How many groups of stale issues are fetched: the people, plus Unassigned when issues without an assignee are fetched too. */
  const groupCount = st => st.people.length + (st.unassigned ? 1 : 0);

  /** The groups in the filter menu, in order: the people, then Unassigned. `short` is the label on the closed menu:
   *  first names, unless two people share one. The counts are of all fetched issues, not of the filtered list. */
  function staleGroups() {
    const { people, unassigned, counts } = C.stale;
    const short = p => (isMe(p) ? t('person.you') : people.some(q => q !== p && firstName(q) === firstName(p)) ? p.name : firstName(p));
    const groups = people.map(p => ({ id: p.accountId, name: isMe(p) ? t('person.you') : p.name, short: short(p), avatar: avatar(p, 'xs'), n: counts[p.accountId] }));
    if (unassigned) groups.push({ id: UNASSIGNED, name: t('person.unassigned'), short: t('person.unassigned'), avatar: avatar(null, 'xs'), n: counts[UNASSIGNED] });
    return groups;
  }

  /** Filter by group (a person, or Unassigned), only when you fetch stale issues of more than one group. Nothing chosen = everyone.
   *  A button in the title row with a dropdown menu, so the filter takes no space above the list. */
  function staleFilterMenu() {
    if (groupCount(C.stale) < 2) return '';
    const f = C.stale.filter, groups = staleGroups();
    const chosen = groups.filter(g => f.includes(g.id));
    const current = chosen.length ? `${esc(chosen[0].short)}${chosen.length > 1 ? ` +${chosen.length - 1}` : ''}` : esc(t('stale.everyone'));
    // With an id the focus survives the re-render after each click, so you can keep ticking with the keyboard.
    const item = (id, on, who, n) => `<button id="sf-${esc(id || 'all')}" class="fitem ${id ? '' : 'all'}" data-action="stale-filter" data-id="${esc(id)}" aria-pressed="${on}">${icon('check')}${who}<span class="n">${n}</span></button>`;
    return `<div class="filter">
      <button id="stale-menu" class="btn sm ghost ftoggle ${f.length ? 'on' : ''}" data-action="stale-menu" aria-expanded="${UI.staleMenu}" title="${esc(t('stale.filterTitle'))}">${chosen.length === 1 ? chosen[0].avatar : ''}<span>${current}</span>${icon('chevron')}</button>
      ${UI.staleMenu ? `<div class="fmenu" role="group" aria-label="${esc(t('stale.filterTitle'))}">
        ${item('', !f.length, `<span class="fname">${esc(t('stale.everyone'))}</span>`, S.stale.issues.length)}
        ${groups.map(g => item(g.id, f.includes(g.id), `${g.avatar}<span class="fname">${esc(g.name)}</span>`, g.n)).join('')}
      </div>` : ''}
    </div>`;
  }

  function staleRow(key) {
    const i = staleIssue(key), d = daysIdle(i);
    // With more groups the main question is whose issue it is (or that it is nobody's); the date is in the detail.
    const sub = groupCount(C.stale) > 1 ? person(i.assignee) : esc(t('stale.lastUpdated', { date: fmtDate(i.updated) }));
    return `<div class="va-row ${UI.selected === key ? 'sel' : ''}" data-action="select" data-key="${esc(key)}" data-row="${esc(key)}" tabindex="0">
      <span class="va-dot"></span>
      <div class="va-row-main">
        <div class="va-row-top">${typeIcon(i)}<span class="key">${esc(key)}</span>${issuePill(i)}<span class="idle ${idleCls(d)}">${esc(t('stale.days', { n: d }))}</span></div>
        <div class="va-row-sum">${esc(i.summary)}</div>
        <div class="va-row-sub">${sub}${find(key) ? ` · ${icon('eye')}${esc(t('stale.tracked'))}` : ''}</div>
      </div>
    </div>`;
  }

  function detail(v) {
    const key = UI.selected;
    let body;
    if (!key) body = v === 'changed' && configured() && S.tracked.length ? zero()
      : v === 'changed' && configured() ? startCard()
      : !configured() && v !== 'tracked' ? `<div class="va-empty">${esc(t(v === 'stale' ? 'stale.connectFirst' : 'detail.connectFirst'))}</div>`
      : selectHint();
    else if (v === 'stale') body = staleDetail(key);
    else body = trackedDetail(key);
    return `<section class="va-detail" data-scroll-key="detail"><div class="drag-zone"></div>${body}</section>`;
  }

  const selectHint = () => `<div class="va-empty">${esc(t('detail.select'))}</div>`;

  const zero = () => `<div class="va-empty"><div class="zero">
    <span class="zero-ico">${icon('check')}</span>
    <h2>${esc(t('detail.allProcessed'))}</h2>
    <p>${failed() ? failedMaybe() : esc(t('detail.zeroHint'))}</p>
  </div></div>`;

  // First start without tracked issues: empty here means "not started yet", not "all processed".
  const startCard = () => `<div class="va-empty"><div class="zero">
    <span class="zero-ico start">${icon('inbox')}</span>
    <h2>${esc(t('detail.startTitle'))}</h2>
    <p>${esc(t('detail.startHint'))}</p>
    <button class="btn primary" data-action="focus-add">${esc(t('detail.startTrack'))}</button>
  </div></div>`;

  const back = () => `<button class="btn ghost va-back" data-action="close-detail">${icon('back')}${esc(t('detail.back'))}</button>`;

  /** "· Bug in Webshop · tracked since 3 Oct": the parts that exist, without a dangling "·". */
  function detailTop(i, since) {
    const type = i.type && i.project ? t('detail.typeInProject', { type: i.type, project: i.project }) : i.type || i.project;
    const parts = [type, since].filter(Boolean);
    return parts.length ? `<span>· ${esc(parts.join(' · '))}</span>` : '';
  }

  function trackedDetail(key) {
    const tr = find(key);
    if (!tr) return selectHint();
    if (tr.loading) return `<div class="va-d">${back()}<div class="va-d-top"><span class="key">${esc(key)}</span></div><div class="skel big"></div><div class="skel"></div></div>`;
    const actions = `<button class="btn" data-action="jira" data-key="${esc(key)}">${icon('external')}${esc(t('detail.openInJira'))}</button>
      <button class="btn ghost" data-action="untrack" data-key="${esc(key)}">${icon('eyeOff')}${esc(t('detail.untrack'))}</button>`;
    if (!tr.issue) {
      return `<div class="va-d">${back()}<div class="va-d-top"><span class="key">${esc(key)}</span></div>
        <div class="banner err">${icon('alert')}<span>${esc(tr.error || t('row.notFetched'))}</span></div><div class="va-d-actions">${actions}</div></div>`;
    }
    const i = tr.issue, p = pending(tr), done = tr.changes.filter(c => c.processed);
    return `<div class="va-d">
      ${back()}
      <div class="va-d-top">${typeIcon(i)}<span class="key">${esc(key)}</span>${detailTop(i, t('detail.trackedSince', { date: fmtDate(tr.addedAt) }))}</div>
      <h2 class="va-d-title">${esc(i.summary)}</h2>
      ${tr.error ? `<div class="banner err">${icon('alert')}<span>${esc(tr.error)}</span></div><br>` : ''}
      ${metaGrid(i)}
      <div class="va-d-actions">
        ${p.length
          ? `<button class="btn ok" data-action="mark" data-key="${esc(key)}">${icon('check')}${esc(t('detail.markProcessed'))}<kbd>E</kbd></button>`
          : `<span class="va-done">${icon('check')}${esc(lastProcessedAt(tr) ? t('detail.processedAgo', { when: rel(lastProcessedAt(tr)) }) : t('detail.nothingToProcess'))}</span>`}
        ${actions}
      </div>
      ${relationsHtml(i)}
      ${descriptionHtml(i)}
      ${p.length
        ? `<h3 class="va-sec">${esc(t('detail.newSince'))} <span class="chip">${p.length}</span></h3>${timeline(p)}`
        : failed()
          ? `<div class="va-quiet">${esc(tr.lastChecked ? t('detail.failedQuietSince', { when: rel(tr.lastChecked) }) : t('detail.failedQuiet'))}</div>`
          : `<div class="va-quiet">${t('detail.quiet', { when: tr.lastChecked ? esc(rel(tr.lastChecked)) : syncLast() })}</div>`}
      ${p.length ? '' : activityHtml(key)}
      ${done.length ? `<h3 class="va-sec muted">${esc(t('detail.processedBefore'))}</h3>${timeline(done)}` : ''}
    </div>`;
  }

  function staleDetail(key) {
    const i = staleIssue(key);
    if (!i) return selectHint();
    const d = daysIdle(i);
    return `<div class="va-d">
      ${back()}
      <div class="va-d-top">${typeIcon(i)}<span class="key">${esc(key)}</span>${detailTop(i)}</div>
      <h2 class="va-d-title">${esc(i.summary)}</h2>
      <div class="va-stale-hero ${idleCls(d)}"><b>${d}</b><span>${esc(t('stale.idle', { n: d }))}<br><small>${esc(t('stale.since', { date: fmtDate(i.updated) }))}</small></span></div>
      ${metaGrid(i, { updated: false, due: false })}
      <div class="va-d-actions">
        <button class="btn primary" data-action="jira" data-key="${esc(key)}">${icon('external')}${esc(t('detail.openInJira'))}</button>
        ${find(key) ? `<span class="va-done">${icon('eye')}${esc(t('stale.alreadyTracked'))}</span>` : `<button class="btn" data-action="track" data-key="${esc(key)}">${icon('eye')}${esc(t('stale.trackToo'))}</button>`}
      </div>
      ${relationsHtml(i)}
      ${activityHtml(key)}
    </div>`;
  }

  /* ---------- notes ---------- */

  const COUNT_FROM = 200; // above this many characters the title shows a counter

  function draftTypeField(d) {
    if (d.typesState === 'loading') return `<select id="draft-type" data-draft-type disabled><option>${esc(t('draft.typesLoading'))}</option></select>`;
    if (d.typesState === 'error' || !d.types.length) return `<select id="draft-type" data-draft-type disabled><option>${esc(t('draft.defaultType'))}</option></select>`;
    return `<select id="draft-type" data-draft-type>${d.types.map(ty => `<option value="${esc(ty.id)}" ${ty.id === d.typeId ? 'selected' : ''}>${esc(ty.name)}</option>`).join('')}</select>`;
  }

  /** The panel under a note: review summary, project and type before anything goes to Jira. */
  function draftPanel(n, d) {
    const busy = d.creating || !!n.creating;
    const project = d.project || notesProjectOf(S.settings);
    return `<div class="note-draft" data-draft role="group" aria-label="${esc(t('draft.label'))}">
      <label class="dfld"><span class="dfld-l">${esc(t('field.summary'))} <small id="draft-count" class="draft-count">${draftCount(d.summary)}</small></span>
        <input id="draft-summary" type="text" data-draft-field value="${esc(d.summary)}" maxlength="${NOTE_MAX}" autocomplete="off" ${busy ? 'readonly' : ''}></label>
      <div class="dfld-row">
        <label class="dfld"><span class="dfld-l">${esc(t('draft.project'))}</span>
          <input id="draft-project" type="text" data-draft-field value="${esc(d.project)}" maxlength="20" autocomplete="off" autocapitalize="characters" spellcheck="false" ${busy ? 'readonly' : ''}></label>
        <label class="dfld"><span class="dfld-l">${esc(t('field.issuetype'))}</span>${draftTypeField(d)}</label>
      </div>
      ${d.typesState === 'error' ? `<p class="draft-msg err-text">${esc(t('draft.typesError', { error: d.typesError }))}</p>` : ''}
      ${d.error ? `<p class="draft-msg err-text" role="alert" id="draft-error">${esc(d.error)}</p>` : ''}
      ${project ? `<p class="va-hint">${esc(t('draft.backlog', { project }))}</p>` : ''}
      <div class="draft-actions">
        <button class="btn primary sm" data-action="draft-create" ${busy || !d.summary.trim() ? 'disabled' : ''}>${busy ? `${icon('refresh', 'spin')}${esc(t('draft.creating'))}` : esc(t('draft.create'))}</button>
        <button class="btn sm" data-action="draft-cancel" ${busy ? 'disabled' : ''}>${esc(t('draft.cancel'))}</button>
      </div>
    </div>`;
  }
  const draftCount = text => (text.length > COUNT_FROM ? `${text.length}/${NOTE_MAX}` : '');

  function noteRow(n) {
    const busy = !!n.creating;
    const id = esc(n.id);
    const draft = UI.draft?.id === n.id && !n.done ? UI.draft : null;
    return `<li class="note ${n.done ? 'done' : ''} ${draft || busy ? 'open' : ''}">
      <button id="note-grip-${id}" class="note-grip" type="button" data-note-grip data-id="${id}" title="${esc(t('notes.gripTitle', { up: `${ALT}↑`, down: `${ALT}↓` }))}" aria-label="${esc(t('notes.move'))}">${icon('grip')}</button>
      <input id="note-done-${id}" class="note-check" type="checkbox" data-note-done data-id="${id}" title="${esc(t(n.done ? 'notes.reopen' : 'notes.tickOff'))}" aria-label="${esc(t('notes.done'))}" ${n.done ? 'checked' : ''} ${busy ? 'disabled' : ''}>
      <textarea id="note-${id}" class="note-text" rows="1" data-note-text data-id="${id}" maxlength="${NOTE_MAX}" autocomplete="off" title="${esc(t('notes.editTitle'))}" aria-label="${esc(t('notes.note'))}" ${busy ? 'readonly' : ''}>${esc(n.text)}</textarea>
      <time class="note-time" title="${fmtTime(n.createdAt)}">${relShort(n.createdAt)}</time>
      ${n.done ? `<button class="btn sm note-ghost" type="button" tabindex="-1" aria-hidden="true">${icon('plus')}${esc(t('notes.createIssue'))}</button>` : `<button class="btn sm" data-action="note-issue" data-id="${id}" ${busy ? 'disabled' : ''}>${busy ? `${icon('refresh', 'spin')}${esc(t('draft.creating'))}` : `${icon('plus')}${esc(t('notes.createIssue'))}`}</button>`}
      <button class="btn icon sm ghost" data-action="note-remove" data-id="${id}" title="${esc(t('notes.remove'))}" ${busy ? 'disabled' : ''}>${icon('trash')}</button>
      ${draft ? draftPanel(n, draft) : ''}
    </li>`;
  }

  function notesPage() {
    const project = notesProjectOf(S.settings);
    return `<section class="va-page" data-scroll-key="notes"><div class="drag-zone"></div><div class="va-page-inner va-notes">
      <h1>${esc(t('nav.notes'))}</h1>
      <p class="va-hint">${project
        ? t('notes.hint', { button: `<b>${esc(t('notes.createIssue'))}</b>` })
        : t('notes.noProject', { settings: `<button class="linkish" data-action="view" data-view="settings">${esc(t('nav.settings'))}</button>` })}</p>
      <form class="va-add" data-form="note">
        <div class="va-add-field">${icon('plus')}<input id="note-input" type="text" data-note-input maxlength="${NOTE_MAX}" autocomplete="off" placeholder="${esc(t('notes.placeholder'))}" value="${esc(UI.noteText)}"></div>
      </form>
      ${S.notes.length ? `<ul class="notes">${S.notes.map(noteRow).join('')}</ul>` : `<div class="va-empty-list">${esc(t('notes.empty'))}</div>`}
    </div></section>`;
  }

  /* ---------- settings ---------- */

  function connHtml() {
    const c = UI.conn;
    if (c === 'busy') return `<span class="conn">${icon('refresh', 'spin')} ${esc(t('settings.connecting'))}</span>`;
    if (c) return `<span class="conn ${c.ok ? 'ok' : 'err'}">${icon(c.ok ? 'check' : 'x')} ${esc(c.message)}</span>`;
    if (S.me && configured()) return `<span class="conn ok">${icon('check')} ${esc(t('status.connectedAs', { name: S.me.name || t('person.unknown') }))}</span>`;
    return '';
  }

  function notifyHtml() {
    if (UI.notifyBusy) return `<span class="conn">${icon('refresh', 'spin')} ${esc(t('settings.notifySending'))}</span>`;
    const r = S.notifications;
    if (!r) return '';
    if (r.ok === true) return `<span class="conn ok">${icon('check')} ${esc(t('settings.notifyShown', { when: rel(r.at) }))}</span>`;
    if (r.ok === false) return `<span class="conn err">${icon('x')} ${esc(t('settings.notifyFailed', { error: r.error || t('settings.notifyUnknownError') }))}</span>`;
    return `<span class="conn">${esc(t('settings.notifyNoAnswer'))}${MAC ? ` ${t('settings.notifyNoAnswerMac', { allow: `<b>${esc(t('settings.notifyAllow'))}</b>` })}` : ''}</span>`;
  }

  /** Settings → About: what the last update check found. Only the version that is available is a link. */
  function updateStatusHtml() {
    if (UI.updateBusy) return `<span class="conn">${icon('refresh', 'spin')} ${esc(t('updates.checking'))}</span>`;
    if (UI.updateFailed) return `<span class="conn err">${icon('x')} ${esc(t('updates.failed'))}</span>`;
    const u = S.updates;
    if (u?.newer) return `<span class="conn">${esc(t('updates.available', { version: u.latest }))} · <button type="button" class="linkish" data-action="view-release" data-url="${esc(u.url)}">${esc(t('updates.view'))}</button></span>`;
    if (u?.lastCheck) return `<span class="conn ok">${icon('check')} ${esc(t('updates.upToDate'))}</span>`;
    return '';
  }

  const PEOPLE_MAX = 100;

  /** Choice list: the colleagues from Jira, you, and whoever is already ticked (even if no longer in Jira's list). */
  function peopleOptions() {
    const all = new Map();
    for (const p of [...S.people.list, ...(S.me ? [S.me] : []), ...S.settings.stalePeople]) {
      if (!all.has(p.accountId)) all.set(p.accountId, { accountId: p.accountId, name: p.name });
    }
    return sortPeople([...all.values()], S.me, t.locale);
  }

  function peopleListHtml() {
    const chosen = new Set(inbox().stale.people.map(p => p.accountId));
    const q = fold(UI.peopleQuery.trim());
    const found = peopleOptions().filter(p => !q || fold(p.name).includes(q));
    if (!found.length) return q ? `<li class="people-more">${esc(t('settings.peopleNone'))}</li>` : '';
    return found.slice(0, PEOPLE_MAX).map(p => {
      const on = chosen.has(p.accountId);
      const last = on && chosen.size === 1; // at least one stays ticked
      return `<li><label class="person" ${last ? `title="${esc(t('settings.peopleLast'))}"` : ''}>
        <input id="person-${esc(p.accountId)}" type="checkbox" data-person="${esc(p.accountId)}" ${on ? 'checked' : ''} ${last ? 'disabled' : ''}>${avatar(p, 'xs')}<span>${esc(p.name)}${isMe(p) ? ` <span class="muted">${esc(t('person.youSuffix'))}</span>` : ''}</span>
      </label></li>`;
    }).join('') + (found.length > PEOPLE_MAX ? `<li class="people-more">${esc(t('settings.peopleMore', { n: found.length - PEOPLE_MAX }))}</li>` : '');
  }

  function peopleField() {
    const P = S.people;
    let status = '';
    if (!configured()) status = esc(t('settings.peopleConnectFirst'));
    else if (P.error) status = `<span class="err-text">${esc(t('settings.peopleFailed', { error: P.error }))}</span> <button class="linkish" data-action="people-reload">${esc(t('settings.peopleRetry'))}</button>`;
    else if (P.loading && !P.list.length) status = `<span class="conn">${icon('refresh', 'spin')} ${esc(t('settings.peopleLoading'))}</span>`;
    const chosen = C.stale.people, nobody = C.stale.unassigned;
    // The chosen people as chips, so you see them even with a long list; × only while there is more than one person. Unassigned is a chip too.
    const chip = (av, label, id, name, removable) => `<span class="pchip">${av}<span class="pchip-n">${esc(label)}</span>${removable ? `<button type="button" class="pchip-x" data-action="person-remove" data-id="${esc(id)}" title="${esc(t('settings.peopleRemove'))}" aria-label="${esc(t('settings.peopleRemoveName', { name }))}">${icon('x')}</button>` : ''}</span>`;
    const chips = !chosen.length ? '' : `<div class="people-chips">${chosen.map(p => chip(avatar(p, 'xs'), isMe(p) ? t('person.you') : p.name, p.accountId, p.name, chosen.length > 1)).join('')}${nobody ? chip(avatar(null, 'xs'), t('person.unassigned'), UNASSIGNED, t('person.unassigned'), true) : ''}</div>`;
    return `<div class="fld"><span class="fld-l">${esc(t('settings.people'))}</span>
      ${chips}
      ${peopleOptions().length > 8 ? `<input id="people-q" type="text" data-people-q value="${esc(UI.peopleQuery)}" placeholder="${esc(t('settings.peopleSearch'))}" autocomplete="off" spellcheck="false" aria-label="${esc(t('settings.peopleSearchLabel'))}">` : ''}
      <ul class="people" data-people-list>${peopleListHtml()}</ul>
      ${configured() ? `<label class="person nobody"><input id="person-${UNASSIGNED}" type="checkbox" data-person="${UNASSIGNED}" ${nobody ? 'checked' : ''}>${avatar(null, 'xs')}<span>${esc(t('person.unassigned'))}</span></label>` : ''}
      ${status ? `<small>${status}</small>` : ''}
      <small>${esc(t('settings.peopleHint'))}</small>
    </div>`;
  }

  const THEME_ICONS = { system: 'monitor', light: 'sun', dark: 'moon' }; // the label is theme.<value>
  const themePicker = theme => `<div class="seg" role="radiogroup" aria-label="${esc(t('settings.theme'))}">${THEMES.map(value => `
    <label class="seg-opt ${theme === value ? 'on' : ''}"><input type="radio" name="theme" data-setting="theme" value="${value}" ${theme === value ? 'checked' : ''}>${icon(THEME_ICONS[value])}<span>${esc(t(`theme.${value}`))}</span></label>`).join('')}
  </div>`;

  /** System first (follows the computer, else English), then each registered language by its own name. */
  function languagePicker(setting) {
    const value = LANGUAGE_SETTINGS.includes(setting) ? setting : 'system';
    const label = code => (code === 'system' ? t('language.system') : LANGUAGE_NAMES[code]);
    return `<select id="set-language" data-setting="language">${LANGUAGE_SETTINGS.map(code => `<option value="${code}" ${code === value ? 'selected' : ''}>${esc(label(code))}</option>`).join('')}</select>`;
  }

  function settingsForm() {
    const s = S.settings;
    return `<div class="set">
      <div class="set-col">
        <fieldset>
          <legend>${esc(t('settings.account'))}</legend>
          <label class="fld"><span class="fld-l">${esc(t('settings.jiraUrl'))}</span><input id="set-baseUrl" type="url" data-setting="baseUrl" value="${esc(s.baseUrl)}" placeholder="${esc(t('settings.urlPlaceholder'))}" autocomplete="off" spellcheck="false"></label>
          <label class="fld"><span class="fld-l">${esc(t('settings.email'))}</span><input id="set-email" type="email" data-setting="email" value="${esc(s.email)}" placeholder="${esc(t('settings.emailPlaceholder'))}" autocomplete="off" spellcheck="false"></label>
          <div class="fld"><label class="fld-l" for="set-token">${esc(t('settings.apiToken'))}</label>
            <input id="set-token" type="password" data-token autocomplete="off" spellcheck="false" placeholder="${esc(t(s.hasToken ? 'settings.tokenSaved' : 'settings.tokenPlaceholder'))}">
            <small>${t('settings.tokenHint', { link: `<button class="linkish" data-action="token-page">${esc(t('settings.tokenLink'))}</button>` })}</small>
          </div>
          <div class="set-row"><button type="button" class="btn" data-action="test-conn">${esc(t('settings.testConnection'))}</button>${connHtml()}</div>
        </fieldset>
        <fieldset>
          <legend>${esc(t('settings.checking'))}</legend>
          <label class="fld"><span class="fld-l">${esc(t('settings.interval'))}</span><select id="set-interval" data-setting="interval">${INTERVALS.map(m => `<option value="${m}" ${s.interval === m ? 'selected' : ''}>${esc(t('settings.minutes', { n: m }))}</option>`).join('')}</select></label>
          <label class="fld"><span class="fld-l">${esc(t('settings.defaultProject'))}</span><input id="set-defaultProject" type="text" data-setting="defaultProject" value="${esc(s.defaultProject)}" placeholder="${esc(t('settings.example', { example: 'WEB' }))}" autocomplete="off" spellcheck="false"><small>${esc(t('settings.defaultProjectHint', { project: s.defaultProject || t('settings.projectSample') }))}</small></label>
          <label class="check"><input id="set-openAtLogin" type="checkbox" data-setting="openAtLogin" ${s.openAtLogin ? 'checked' : ''}> ${esc(t('settings.openAtLogin'))}</label>
        </fieldset>
        <fieldset>
          <legend>${esc(t('settings.notifications'))}</legend>
          <label class="check"><input id="set-notify" type="checkbox" data-setting="notify" ${s.notify ? 'checked' : ''}> ${esc(t('settings.notify'))}</label>
          <label class="check"><input id="set-ignoreOwn" type="checkbox" data-setting="ignoreOwn" ${s.ignoreOwn ? 'checked' : ''}> ${esc(t('settings.ignoreOwn'))}</label>
          <div class="set-row"><button type="button" class="btn" data-action="test-notify" ${UI.notifyBusy ? 'disabled' : ''}>${esc(t('settings.testNotify'))}</button>${notifyHtml()}</div>
          ${S.env?.platform === 'darwin' && !S.env.packaged ? `<div class="banner warn">${icon('alert')}<span>${t('settings.devBuild', { start: '<code>npm start</code>', dist: '<code>npm run dist</code>' })}</span></div>` : ''}
          <small>${esc(t('settings.notifyHint'))}${S.env?.platform === 'darwin' ? ` ${t('settings.notifyHintMac', { link: `<button class="linkish" data-action="notify-settings">${esc(t('settings.notifySettingsLink'))}</button>` })}` : ''}</small>
        </fieldset>
        <fieldset>
          <legend>${esc(t('settings.appearance'))}</legend>
          <div class="fld"><span class="fld-l">${esc(t('settings.theme'))}</span>${themePicker(s.theme || 'system')}<small>${esc(t(S.env?.platform === 'darwin' ? 'settings.themeHintMac' : 'settings.themeHint'))}</small></div>
          <label class="fld"><span class="fld-l">${esc(t('settings.language'))}</span>${languagePicker(s.language)}<small>${esc(t('language.systemHint', { name: LANGUAGE_NAMES[resolveLanguage('system', S.env?.locale)] }))}</small></label>
        </fieldset>
      </div>
      <div class="set-col">
        <fieldset>
          <legend>${esc(t('settings.stale'))}</legend>
          ${peopleField()}
          <label class="fld"><span class="fld-l">${esc(t('settings.staleDays'))}</span><input id="set-staleDays" type="number" min="1" max="365" data-setting="staleDays" value="${s.staleDays}"></label>
          <label class="fld"><span class="fld-l">${esc(t('settings.excluded'))}</span><input id="set-excluded" type="text" data-setting="excluded" value="${esc(s.excluded.join(', '))}" placeholder="${esc(t('settings.example', { example: 'Backlog, On hold' }))}" autocomplete="off"><small>${esc(t('settings.excludedHint', { example: 'Backlog, On hold' }))}</small></label>
          <label class="fld"><span class="fld-l">${esc(t('settings.excludedProjects'))}</span><input id="set-excludedProjects" type="text" data-setting="excludedProjects" value="${esc(s.excludedProjects.join(', '))}" placeholder="${esc(t('settings.example', { example: 'ARCHIVE-*, Sandbox' }))}" autocomplete="off" spellcheck="false"><small>${esc(t('settings.excludedProjectsHint'))}</small></label>
        </fieldset>
        <fieldset>
          <legend>${esc(t('nav.notes'))}</legend>
          <label class="fld"><span class="fld-l">${esc(t('settings.notesProject'))}</span><input id="set-notesProject" type="text" data-setting="notesProject" value="${esc(s.notesProject)}" placeholder="${esc(t('settings.example', { example: 'OPS' }))}" autocomplete="off" spellcheck="false"><small>${esc(t('settings.notesProjectHint', { button: t('notes.createIssue') }))}</small></label>
        </fieldset>
        <fieldset>
          <legend>${esc(t('settings.about'))}</legend>
          <p class="about-version">${esc(t('settings.aboutVersion', { version: S.version }))}</p>
          <label class="check"><input id="set-checkUpdates" type="checkbox" data-setting="checkUpdates" ${s.checkUpdates ? 'checked' : ''}> ${esc(t('settings.checkUpdates'))}</label>
          <div class="set-row"><button type="button" class="btn" data-action="check-updates" ${UI.updateBusy ? 'disabled' : ''}>${esc(t('updates.checkNow'))}</button><span id="update-status" role="status">${updateStatusHtml()}</span></div>
          ${S.updates?.newer && MAC ? `<small>${t('updates.homebrew', { command: '<code>brew upgrade --cask issuemon</code>' })}</small>` : ''}
        </fieldset>
      </div>
    </div>`;
  }

  const settingsPage = () => `<section class="va-page" data-scroll-key="settings"><div class="drag-zone"></div><div class="va-page-inner">
    <h1>${esc(t('nav.settings'))} <span class="saved" data-saved>${icon('check')}${esc(t('settings.saved'))}</span></h1>
    ${settingsForm()}
  </div></section>`;

  /* ---------- connect screen (first start) ---------- */

  const connectValue = name => UI.connectDraft?.[name] ?? (name === 'token' ? '' : S.settings[name]);
  // The first field you still have to fill in; the token counts as filled once one is stored.
  const firstEmptyConnectField = () => ['baseUrl', 'email', 'token'].find(n => !connectValue(n).trim() && !(n === 'token' && S.settings.hasToken));

  function connectPage() {
    // Connected: the next steps instead of the form. A failed or running attempt keeps the form.
    const done = UI.conn ? UI.conn.ok === true : configured() && !!S.me;
    const busy = UI.conn === 'busy';
    let body;
    if (done) {
      const n = S.stale.issues.length; // total, regardless of the person filter
      body = `<h1>${icon('check', 'ok')} ${esc(S.me ? t('status.connectedAs', { name: S.me.name || t('person.unknown') }) : UI.conn.message)}</h1>
        <p class="va-hint">${esc(t('connect.connected'))}</p>
        <div class="next">
          <div class="next-row"><button class="btn primary" data-action="connect-done">${icon('plus')}${esc(t('connect.trackFirst'))}</button></div>
          ${S.stale.fetchedAt ? `<div class="next-row"><span>${esc(n ? t('connect.staleCount', { n }) : t('connect.staleNone'))}</span>${n ? `<button class="btn sm" data-action="view" data-view="stale">${esc(t('connect.view'))}</button>` : ''}</div>` : ''}
          <div class="next-row"><button class="btn ghost" data-action="view" data-view="settings">${icon('sliders')}${esc(t('connect.moreSettings'))}</button></div>
        </div>`;
    } else {
      const hasToken = S.settings.hasToken;
      body = `<h1>${esc(t('connect.title'))}</h1>
        <p class="va-hint">${esc(t('connect.intro'))}</p>
        <form class="set" data-form="connect" novalidate>
          <label class="fld"><span class="fld-l">${esc(t('settings.jiraUrl'))}</span><input id="conn-baseUrl" type="url" data-connect-field="baseUrl" value="${esc(connectValue('baseUrl'))}" placeholder="${esc(t('settings.urlPlaceholder'))}" autocomplete="off" spellcheck="false"></label>
          <label class="fld"><span class="fld-l">${esc(t('settings.email'))}</span><input id="conn-email" type="email" data-connect-field="email" value="${esc(connectValue('email'))}" placeholder="${esc(t('settings.emailPlaceholder'))}" autocomplete="off" spellcheck="false"></label>
          <div class="fld"><label class="fld-l" for="conn-token">${esc(t('settings.apiToken'))}</label>
            <input id="conn-token" type="password" data-connect-field="token" value="${esc(connectValue('token'))}" autocomplete="off" spellcheck="false" placeholder="${esc(t(hasToken ? 'connect.tokenSaved' : 'settings.tokenPlaceholder'))}">
            <small>${t('connect.tokenHint', { link: `<button type="button" class="linkish" data-action="token-page">${esc(t('settings.tokenLink'))}</button>` })}</small>
          </div>
          <div class="set-row"><button type="submit" class="btn primary" data-action="connect" ${busy ? 'disabled' : ''}>${esc(t('connect.connect'))}</button><span role="status" aria-live="polite">${connHtml()}</span></div>
        </form>`;
    }
    return `<section class="va-page" data-scroll-key="connect"><div class="drag-zone"></div><div class="va-page-inner va-connect">${body}</div></section>`;
  }

  function focusConnect() {
    const n = firstEmptyConnectField() || 'baseUrl';
    const el = $(`#conn-${n}`);
    if (el) { el.focus(); el.select?.(); }
  }

  async function connect(form) {
    const val = n => form.querySelector(`#conn-${n}`).value.trim();
    UI.connectDraft = { baseUrl: val('baseUrl'), email: val('email'), token: val('token') };
    const { baseUrl, email, token } = UI.connectDraft;
    if (UI.conn === 'busy') return;
    if (!baseUrl || !email || !(token || S.settings.hasToken)) {
      UI.conn = { ok: false, message: t('connect.incomplete') };
      render();
      focusConnect();
      return;
    }
    UI.conn = 'busy';
    render();
    const saved = await api.saveSettings({ baseUrl, email });
    if (saved.urlRefused) { // refused by the main process: not an address, or plain http to a non-local host
      UI.conn = { ok: false, message: t('connect.urlInvalid') };
      render();
      focusConnect();
      return;
    }
    UI.conn = token ? await api.setToken(token) : await api.testConnection();
    UI.connectDraft = UI.conn.ok ? null : { ...UI.connectDraft, baseUrl: null, email: null }; // on an error the token stays; URL and email come back normalized from the settings
    render();
  }

  /* ---------- render ---------- */

  let rendering = false;
  const dirtyFields = new WeakSet();

  function render() {
    if (!S || drag) return; // not while dragging a note; a render follows on release
    const root = $('#app');
    const scroll = {};
    root.querySelectorAll('[data-scroll-key]').forEach(el => { scroll[el.dataset.scrollKey] = el.scrollTop; });
    // The focused element survives a re-render; a text field keeps its unsaved text too.
    const ae = document.activeElement;
    const typing = ae && ae.id && root.contains(ae) && ae.matches('input:not([type=checkbox]), textarea');
    const focus = ae && ae.id && root.contains(ae) ? { id: ae.id, value: typing ? ae.value : null, s: ae.selectionStart, e: ae.selectionEnd } : null;
    Object.assign(UI, settle(S, UI, { wide: wide(), locale: t.locale })); // first make the selection consistent, then draw: draw() doesn't change UI
    // Removing a focused, edited field can fire change/blur. That is a redraw,
    // not a user commit. Keep its pending edit until a real change or blur.
    rendering = true;
    try { root.innerHTML = draw(); } finally { rendering = false; }
    root.querySelectorAll('[data-scroll-key]').forEach(el => { const y = scroll[el.dataset.scrollKey]; if (y) el.scrollTop = y; });
    if (focus) {
      const el = document.getElementById(focus.id);
      if (el) {
        if (focus.value != null) el.value = focus.value;
        if (dirtyFields.has(ae)) dirtyFields.add(el);
        el.focus({ preventScroll: true });
        try { el.setSelectionRange(focus.s, focus.e); } catch { /* not every input type */ }
      } else if (dirtyFields.has(ae)) commitField(ae); // navigating away really ends the edit, including via the menu
    }
    if (UI.reveal) { const key = UI.reveal; UI.reveal = null; reveal(key); }
    rowReveal.refresh(); // resume an unfinished native scroll on the replacement list
    const n = C.counts.changed;
    document.title = n ? t('nav.windowTitle', { n }) : 'IssueMon';
    tick();
  }

  /** Render, but not while a mouse button is down: the click on a replaced button would be lost (see `pressed`). */
  function renderSoon() {
    if (!pressed) render();
    else if (!deferred) deferred = setTimeout(flush, 500);
  }

  function tick() {
    if (!S) return;
    const next = S.status.nextCheck;
    const left = next ? Math.max(0, next - Date.now()) : 0;
    const secs = Math.ceil(left / 1000); // round up: never show 0:00 while the check has yet to start
    const txt = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    document.querySelectorAll('[data-next]').forEach(e => { e.textContent = txt; });
    document.querySelectorAll('[data-last]').forEach(e => { e.textContent = rel(S.status.lastCheck); });
  }

  /* ---------- actions ---------- */

  /** The toast action of every Undo; the button calls actions.undo('toast'). The label is read when the toast is made. */
  const UNDO = { get label() { return t('toast.undo'); }, undo: true };

  /** action: { label, fn }, UNDO, or a list of them. An undo toast is the visible target of ⌘Z. ms: how long it stays. */
  function snack(msg, action, kind = '', ms = 5000) {
    const box = $('#snacks');
    const el = document.createElement('div');
    el.className = `snack ${kind}`;
    el.setAttribute('role', 'status');
    const span = document.createElement('span');
    span.textContent = msg;
    el.append(span);
    for (const a of [].concat(action || [])) {
      // Only one "Undo" at a time (actions also holds only one target), otherwise it is unclear what you revert.
      if (a.undo) {
        box.querySelectorAll('.snack.undoable').forEach(s => s.remove());
        el.classList.add('undoable');
      }
      const b = document.createElement('button');
      b.textContent = a.label;
      b.onclick = () => { if (a.undo) actions.undo('toast'); else a.fn(); el.remove(); };
      el.append(b);
    }
    box.append(el);
    while (box.children.length > 3) box.firstElementChild.remove();
    setTimeout(() => el.classList.add('out'), ms);
    setTimeout(() => el.remove(), ms + 300);
  }

  /** The result of an update check as a toast. A manual check (Settings, app menu) always answers; an automatic one only speaks up for a new version. */
  function showUpdate(r) {
    if (r.manual) UI.updateFailed = !r.ok;
    if (r.ok && r.newer) {
      snack(t('updates.available', { version: r.latest }), [
        { label: t('updates.view'), fn: () => api.openRelease(r.url) },
        { label: t('updates.later'), fn: () => api.dismissUpdate() },
      ], 'ok', 15_000);
    } else if (r.manual) {
      snack(r.ok ? t('updates.upToDate') : t('updates.failed'), null, r.ok ? 'ok' : 'warn');
    }
    if (r.manual) render();
  }

  /** Settings → About → Check now. */
  async function checkUpdates() {
    UI.updateBusy = true;
    UI.updateFailed = false;
    render();
    const r = await api.checkUpdates();
    UI.updateBusy = false;
    showUpdate({ ...r, manual: true });
  }

  function flashSaved() {
    document.querySelectorAll('[data-saved]').forEach(el => {
      el.classList.add('show');
      setTimeout(() => el.classList.remove('show'), 1400);
    });
  }

  function setView(view) {
    UI.view = view;
    UI.pendingSelect = null;
    UI.staleMenu = false;
    UI.selected = null;
    UI.detailOpen = false;
    UI.conn = null; // the result of "Test connection" or "Connect" belongs to that page
    render();
    if (view === 'notes') $('[data-note-input]')?.focus();
    if (view === 'connect') focusConnect();
    if (view === 'settings') api.loadPeople(); // main refetches them at most once an hour
  }

  function toggleStaleFilter(id) {
    const st = inbox().stale;
    const f = new Set(st.filter);
    if (!id) f.clear();
    else if (f.has(id)) f.delete(id);
    else f.add(id);
    UI.staleFilter = f.size === groupCount(st) ? [] : [...f]; // everyone chosen is the same as no filter
    api.saveSettings({ staleFilter: UI.staleFilter }); // saved for after a restart; UI.staleFilter stays the source, state pushes don't read it back
    if (!id) UI.staleMenu = false; // Everyone is a reset; people you tick one by one, so then the menu stays open
    render();
  }

  /** Ticks a person in Settings, or Unassigned (id UNASSIGNED): not a person but a setting of its own. */
  async function togglePerson(id, on) {
    let patch;
    if (id === UNASSIGNED) patch = { staleUnassigned: on };
    else {
      const rest = inbox().stale.people.filter(p => p.accountId !== id);
      const next = (on ? [...rest, peopleOptions().find(p => p.accountId === id)] : rest).filter(Boolean).map(p => ({ accountId: p.accountId, name: p.name }));
      if (!next.length) return render(); // the last one stays ticked
      patch = { stalePeople: next };
    }
    // Optimistic, so ticking quickly in a row doesn't work from the previous state.
    const saved = actions.run({ apply: state => Object.assign(state.settings, patch), call: () => api.saveSettings(patch) });
    render();
    await saved;
    flashSaved();
  }

  async function markProcessed(keys) {
    if (UI.view === 'changed' && keys.length === 1 && UI.selected === keys[0]) {
      UI.selected = neighbour(inbox().keys, keys[0]);
      if (!UI.selected) UI.detailOpen = false;
    }
    // Optimistic update; the real state comes from main right after.
    const at = Date.now();
    const done = actions.run({
      apply: state => {
        for (const key of keys) for (const c of pending(state.tracked.find(x => x.key === key) || { changes: [] })) { c.processed = true; c.processedAt = at; }
      },
      call: () => api.markProcessed(keys),
      undo: ids => (ids.length ? { revert: () => api.unmark(ids) } : null),
    });
    render();
    const ids = await done;
    if (!ids.length) return;
    snack(t('toast.processed', { n: keys.length, keys: keys.join(', ') }), UNDO, 'ok');
  }

  async function untrack(key) {
    if (UI.selected === key) UI.detailOpen = false; // render() picks the new selection
    const done = actions.run({
      apply: state => { state.tracked = state.tracked.filter(x => x.key !== key); },
      call: () => api.untrack(key),
      undo: ok => (ok ? { revert: () => api.restore(key) } : null),
    });
    render();
    if (await done) snack(t('toast.untracked', { key }), UNDO);
  }

  /** A field you type or choose in; a checkbox or radio doesn't count, those leave the shortcuts alone. */
  const isTextField = el => el?.closest?.('input:not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable]');

  /** ⌘Z outside a field, or the menu: undo the last undoable action. Its toast disappears with it. */
  function undo(via) {
    if (!actions.undo(via)) return;
    $('#snacks .snack.undoable')?.remove();
  }

  /** Stop tracking all done issues at once, with one toast that restores them all. */
  async function untrackDone() {
    const keys = inbox().tracked.done.map(x => x.key);
    if (!keys.length) return;
    if (keys.includes(UI.selected)) UI.detailOpen = false; // render() picks the new selection
    const done = actions.run({
      apply: state => { state.tracked = state.tracked.filter(x => !keys.includes(x.key)); },
      call: async () => {
        const ok = await Promise.all(keys.map(k => api.untrack(k)));
        return keys.filter((k, i) => ok[i]);
      },
      undo: gone => (gone.length ? { revert: () => Promise.all(gone.map(k => api.restore(k))) } : null),
    });
    render();
    const gone = await done;
    if (gone.length) snack(t('toast.untrackedMany', { n: gone.length }), UNDO);
  }

  /** The undo of an add: untrack the just-added issues again. */
  const undoAdd = r => (r.ok && r.added.length ? { revert: () => r.added.forEach(k => api.untrack(k)) } : null);

  function reportAdd(r) {
    if (!r.ok) return snack(r.error, null, 'warn');
    if (r.added.length) {
      snack(t('toast.nowTracked', { n: r.added.length, keys: r.added.join(', ') }), UNDO, 'ok');
    }
    if (r.duplicates.length) snack(t('toast.alreadyTracked', { n: r.duplicates.length, keys: r.duplicates.join(', ') }));
    if (r.notFound.length) snack(t('toast.notFound', { keys: r.notFound.join(', ') }), null, 'warn');
  }

  // Sets the add field and the preview directly, so render() doesn't put old text back into the focused field.
  function setAddText(text) {
    UI.addText = text;
    const input = $('[data-add-input]');
    if (!input) return;
    input.value = text;
    const prev = input.closest('form')?.querySelector('[data-add-preview]');
    if (prev) prev.innerHTML = addPreviewHtml(text);
  }

  async function add(text) {
    if (!parseKeys(text, S.settings.defaultProject).length) return snack(t('error.noKey', { example: 'ABC-123' }), null, 'warn');
    if (!configured()) { // the text stays, so Enter after connecting tracks right away
      setAddText(text);
      return snack(t('connect.connectFirst'), { label: t('connect.connect'), fn: () => setView('connect') }, 'warn');
    }
    setAddText('');
    UI.view = 'tracked'; // new issues have no changes yet, so show them in Tracked
    render();
    const r = await actions.run({ call: () => api.addIssues(text), undo: undoAdd });
    if (!r.ok) setAddText(text);
    else if (r.added.length) {
      UI.pendingSelect = r.added[0];
      UI.detailOpen = false;
      UI.trackedQuery = ''; // otherwise the filter might hide the new row
    }
    render();
    reportAdd(r);
  }

  async function track(key) {
    reportAdd(await actions.run({ call: () => api.track(key), undo: undoAdd }));
  }

  function addNote(input) {
    const text = input.value;
    if (!text.trim()) return;
    input.value = UI.noteText = ''; // the field stays focused for the next note
    api.addNote(text);
  }

  async function editNote(id, text) {
    // Optimistic update: Esc right after Enter must restore the new text, not the previous one.
    const value = noteText(text);
    const ok = await actions.run({
      apply: state => { const note = state.notes.find(n => n.id === id); if (note && value) note.text = value; },
      call: () => api.editNote(id, text),
    });
    if (!ok) render(); // empty text: the old one comes back
  }

  function setNoteDone(id, done) {
    // Optimistic, so the strikethrough appears immediately.
    actions.run({
      apply: state => { const note = state.notes.find(n => n.id === id); if (note) note.done = done; },
      call: () => api.setNoteDone(id, done),
    });
    render();
  }

  /** Moves a note to position `to` (0 = top), clamped to the list. */
  function moveNote(id, to) {
    const from = S.notes.findIndex(n => n.id === id);
    const index = Math.max(0, Math.min(S.notes.length - 1, to));
    if (from < 0 || index === from) return render();
    actions.run({
      apply: state => {
        const at = state.notes.findIndex(n => n.id === id);
        if (at >= 0 && at !== index) state.notes.splice(index, 0, ...state.notes.splice(at, 1));
      },
      call: () => api.moveNote(id, index),
    });
    render();
  }

  async function removeNote(id) {
    const done = actions.run({
      apply: state => { state.notes = state.notes.filter(n => n.id !== id); },
      call: () => api.removeNote(id),
      undo: ok => (ok ? { revert: () => api.restoreNote(id) } : null),
    });
    render();
    if (await done) snack(t('toast.noteRemoved'), UNDO);
  }

  /** Opens the create panel under a note; there is only one at a time. Nothing goes to Jira yet. */
  function openDraft(id) {
    const note = S.notes.find(n => n.id === id);
    if (!note || note.creating) return;
    if (UI.draft?.creating && UI.draft.id !== id) return snack(t('toast.stillCreating'), null, 'warn');
    if (UI.draft?.id !== id) {
      UI.draft = { id, summary: note.text, project: notesProjectOf(S.settings), typeId: '', types: [], typesState: 'loading', typesFor: null, error: null, creating: false };
      loadDraftTypes();
    }
    render();
    const el = $('#draft-summary');
    if (el) { el.focus(); el.select(); }
  }

  /** Fetches the issue types of the panel's project and picks Task (or Taak), otherwise the first type. */
  async function loadDraftTypes() {
    const d = UI.draft;
    if (!d) return;
    const project = d.project;
    d.typesState = 'loading';
    d.typeId = '';
    d.typesFor = null;
    const r = await api.issueTypes(project);
    if (UI.draft !== d || d.project !== project) return; // closed, or another project in the meantime
    d.typesFor = project;
    if (r.ok) {
      d.types = r.types;
      d.typesState = 'ok';
      d.typeId = defaultIssueType(r.types)?.id || '';
    } else {
      d.types = [];
      d.typesState = 'error';
      d.typesError = r.error;
    }
    renderSoon();
  }

  function closeDraft(restoreFocus) {
    const id = UI.draft?.id;
    UI.draft = null;
    render();
    if (restoreFocus && id) document.querySelector(`[data-action="note-issue"][data-id="${CSS.escape(id)}"]`)?.focus();
  }

  async function createDraft() {
    const d = UI.draft;
    const note = d && S.notes.find(n => n.id === d.id);
    if (!note || d.creating || note.creating || !d.summary.trim()) return;
    d.creating = true;
    d.error = null;
    render();
    // We don't send a type that belonged to another project: Jira then picks the default type itself.
    const r = await api.createIssueFromNote(d.id, { summary: d.summary, project: d.project, typeId: d.typesFor === d.project ? d.typeId : '' });
    d.creating = false;
    if (!r.ok) {
      d.error = r.error;
      if (UI.draft === d) render();
      else snack(r.error, null, 'warn'); // the panel is gone by now: don't swallow the error
      return;
    }
    if (UI.draft === d) UI.draft = null;
    render();
    if (r.tracked) snack(t('toast.created', { key: r.key }), { label: t('toast.view'), fn: () => focusIssue(r.key) }, 'ok');
    else snack(t('toast.createdNotTracked', { key: r.key, error: r.error }), { label: t('detail.openInJira'), fn: () => api.openInJira(r.key) }, 'warn');
  }

  async function testConn() {
    UI.conn = 'busy';
    render();
    UI.conn = await api.testConnection();
    render();
  }

  async function saveToken(value) {
    const token = value.trim();
    if (!token) return;
    UI.conn = 'busy';
    render();
    UI.conn = await api.setToken(token);
    render();
  }

  function focusAdd() {
    if (UI.view === 'stale' || isPage(UI.view)) { UI.view = 'tracked'; render(); }
    const el = $('[data-add-input]');
    if (el) { el.focus(); el.select(); }
  }

  function focusIssue(key) {
    const tr = key && find(key);
    if (!tr) { setView('changed'); return; }
    UI.view = isChanged(tr) ? 'changed' : 'tracked';
    if (UI.view === 'tracked') UI.trackedQuery = ''; // otherwise the row might not be in the list to scroll to
    UI.pendingSelect = key; // render() selects, highlights and scrolls, and expands the Done group if the issue is in it
    UI.detailOpen = true;
    render();
  }

  // Scroll the row into view and clear UI.highlight (already set) once its 2.4 s CSS animation is over, so a later render doesn't replay it.
  function reveal(key) {
    const view = UI.view;
    rowReveal.reveal(() => UI.view === view && UI.selected === key ? document.querySelector(`[data-row="${CSS.escape(key)}"]`) : null);
    setTimeout(() => { if (UI.highlight === key) UI.highlight = null; }, 2400);
  }

  // A reveal is a one-shot request, not a lock on the selected row. User scrolling
  // or another interaction must not be undone by a later state push.
  for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
    document.addEventListener(type, rowReveal.cancel, { capture: true, passive: true });
  }
  window.addEventListener('resize', rowReveal.refresh);

  function move(delta) {
    const keys = inbox().keys;
    if (!keys.length) return;
    const i = keys.indexOf(UI.selected);
    UI.selected = keys[Math.max(0, Math.min(keys.length - 1, i < 0 ? 0 : i + delta))];
    render();
    document.querySelector('.va-row.sel')?.scrollIntoView({ block: 'nearest' });
  }

  const Handlers = {
    view: d => setView(d.view),
    select: d => { UI.selected = d.key; UI.pendingSelect = null; UI.detailOpen = true; render(); },
    'close-detail': () => { UI.detailOpen = false; render(); },
    mark: d => markProcessed([d.key]),
    'mark-all': () => markProcessed(inbox().changed.map(x => x.key)),
    untrack: d => untrack(d.key),
    help: () => { UI.help = !UI.help; render(); },
    'help-close': () => { UI.help = false; render(); },
    'toggle-desc': d => { UI.descOpen[d.key] = !UI.descOpen[d.key]; render(); },
    'toggle-done': () => { if (!inbox().tracked.query) { UI.doneOpen = !UI.doneOpen; render(); } }, // with a filter the group stays open
    'untrack-done': () => untrackDone(),
    related: d => {
      if (find(d.key)) return focusIssue(d.key);
      const keys = parseKeys(d.key);
      if (keys.length !== 1 || keys[0] !== d.key) return;
      snack(t('detail.trackRelated', { key: d.key }), { label: t('detail.track'), fn: () => add(d.key) });
    },
    track: d => track(d.key),
    jira: d => api.openInJira(d.key),
    check: () => api.checkNow(),
    'note-issue': d => openDraft(d.id),
    'draft-create': () => createDraft(),
    'draft-cancel': () => { if (UI.draft && !UI.draft.creating) closeDraft(true); },
    'note-remove': d => removeNote(d.id),
    'stale-filter': d => toggleStaleFilter(d.id),
    'stale-menu': () => { UI.staleMenu = !UI.staleMenu; render(); },
    'stale-sort': () => {
      const staleSort = S.settings.staleSort === 'oldest' ? 'newest' : 'oldest'; // optimistic: the list flips immediately
      actions.run({ apply: state => { state.settings.staleSort = staleSort; }, call: () => api.saveSettings({ staleSort }) });
      render();
    },
    'people-reload': () => api.loadPeople(true),
    'person-remove': d => togglePerson(d.id, false),
    'test-conn': () => testConn(),
    'focus-add': () => { setView('tracked'); focusAdd(); },
    'connect-done': () => { setView('tracked'); focusAdd(); },
    'token-page': () => api.openTokenPage(),
    'notify-settings': () => api.openNotificationSettings(),
    'check-updates': () => checkUpdates(),
    'view-release': d => api.openRelease(d.url),
    'test-notify': async () => {
      UI.notifyBusy = true;
      render();
      await api.testNotification();
      UI.notifyBusy = false;
      render();
    },
  };

  /* ---------- events ---------- */

  document.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (UI.staleMenu && !e.target.closest('.filter')) { UI.staleMenu = false; render(); } // a click outside closes the filter menu
    if (el) Handlers[el.dataset.action]?.(el.dataset, el, e);
  });

  document.addEventListener('submit', e => {
    const f = e.target.closest('[data-form]');
    if (!f) return;
    e.preventDefault();
    if (f.dataset.form === 'add') add(f.querySelector('[data-add-input]').value);
    else if (f.dataset.form === 'note') addNote(f.querySelector('[data-note-input]'));
    else if (f.dataset.form === 'connect') connect(f);
  });

  document.addEventListener('input', e => {
    if (e.target.matches('[data-draft-field]') && UI.draft) {
      const d = UI.draft, el = e.target;
      if (el.id === 'draft-summary') {
        d.summary = el.value;
        const count = $('#draft-count');
        if (count) count.textContent = draftCount(d.summary);
        const create = $('[data-action="draft-create"]');
        if (create) create.disabled = !d.summary.trim() || d.creating;
      } else {
        const value = projectKey(el.value);
        if (value !== el.value) { // uppercase, and no characters a project key doesn't allow
          const pos = Math.max(0, (el.selectionStart ?? value.length) - (el.value.length - value.length));
          el.value = value;
          el.setSelectionRange(pos, pos);
        }
        d.project = value;
      }
      return;
    }
    if (e.target.matches('[data-note-input]')) { UI.noteText = e.target.value; return; }
    if (e.target.matches('[data-connect-field]')) {
      UI.connectDraft = { ...UI.connectDraft, [e.target.dataset.connectField]: e.target.value };
      if (UI.conn && UI.conn !== 'busy' && !UI.conn.ok) { UI.conn = null; $('[role=status]')?.replaceChildren(); } // an old error message disappears as soon as you keep typing
      return;
    }
    if (e.target.matches('[data-people-q]')) {
      UI.peopleQuery = e.target.value;
      const list = $('[data-people-list]');
      if (list) list.innerHTML = peopleListHtml();
      return;
    }
    if (e.target.matches('[data-tracked-filter]')) { UI.trackedQuery = e.target.value; if (!e.isComposing) render(); return; }
    if (!e.target.matches('[data-add-input]')) return;
    UI.addText = e.target.value;
    const prev = e.target.closest('form').querySelector('[data-add-preview]');
    if (prev) prev.innerHTML = addPreviewHtml(UI.addText);
  });

  async function commitField(el) {
    dirtyFields.delete(el);
    if (el.matches('[data-token]')) { saveToken(el.value); el.value = ''; return; }
    if (el.matches('[data-draft-type]') && UI.draft) { UI.draft.typeId = el.value; return; }
    if (el.id === 'draft-project' && UI.draft) {
      // Different project, different types. Don't render right away: this event can be caused by a render removing the field.
      if (UI.draft.typesFor !== UI.draft.project) { loadDraftTypes(); setTimeout(renderSoon); }
      return;
    }
    if (el.matches('[data-note-text]')) { editNote(el.dataset.id, el.value); return; }
    if (el.matches('[data-note-done]')) { setNoteDone(el.dataset.id, el.checked); return; }
    if (el.matches('[data-person]')) { togglePerson(el.dataset.person, el.checked); return; }
    const name = el.dataset?.setting;
    if (!name) return;
    if (name === 'baseUrl' || name === 'email') UI.conn = null;
    const saved = await api.saveSettings({ [name]: el.type === 'checkbox' ? el.checked : el.value });
    if (name === 'baseUrl' && saved.urlRefused) { UI.conn = { ok: false, message: t('connect.urlInvalid') }; render(); return; }
    flashSaved();
  }

  document.addEventListener('change', e => {
    if (!rendering) commitField(e.target);
  });

  document.addEventListener('input', e => {
    if (e.target.matches('input:not([type=checkbox]):not([type=radio]), textarea')) dirtyFields.add(e.target);
  });
  document.addEventListener('blur', e => {
    // A replacement field's value was set by script, so Chromium no longer
    // emits change on blur. Preserve the original edit's commit semantics.
    if (!rendering && dirtyFields.has(e.target)) e.target.dispatchEvent(new Event('change', { bubbles: true }));
  }, true);

  // Paste = track: outside an input field, or in an empty paste field.
  document.addEventListener('paste', e => {
    const el = e.target;
    const inAdd = el.matches?.('[data-add-input]');
    if (!inAdd && el.closest?.('input, textarea, select, [contenteditable]')) return;
    if (inAdd && el.value.trim()) return;
    const text = e.clipboardData?.getData('text') || '';
    if (!parseKeys(text, S.settings.defaultProject).length) return;
    e.preventDefault();
    add(text);
  });

  // Drag notes by the grip: the row moves along live, and the new position is saved on release.
  document.addEventListener('pointerdown', e => {
    const grip = e.button === 0 && e.target.closest?.('[data-note-grip]');
    if (!grip) return;
    e.preventDefault(); // no text selection
    const li = grip.closest('.note');
    drag = { id: grip.dataset.id, li, list: li.parentElement };
    grip.setPointerCapture(e.pointerId);
    li.classList.add('dragging');
    document.body.classList.add('sorting');
  });
  document.addEventListener('pointermove', e => {
    if (!drag) return;
    const before = [...drag.list.children].find(row => {
      if (row === drag.li) return false;
      const r = row.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    }) || null;
    if (drag.li.nextElementSibling !== before) drag.list.insertBefore(drag.li, before);
  });
  function endDrag(keep) {
    const { id, li, list } = drag;
    drag = null;
    document.body.classList.remove('sorting');
    if (keep) moveNote(id, [...list.children].indexOf(li));
    else render(); // cancelled: back to the saved order
  }
  document.addEventListener('pointerup', () => { if (drag) endDrag(true); });
  document.addEventListener('pointercancel', () => { if (drag) endDrag(false); });

  const isUndoKey = e => (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z';
  document.addEventListener('keydown', e => {
    const typing = isTextField(e.target);
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); focusAdd(); return; }
    if (UI.help && e.key === 'Escape') { e.preventDefault(); UI.help = false; render(); return; }
    if (drag) { if (e.key === 'Escape') { e.preventDefault(); endDrag(false); } return; }
    if (UI.staleMenu && e.key === 'Escape') { e.preventDefault(); UI.staleMenu = false; render(); $('#stale-menu')?.focus(); return; }
    if (UI.staleMenu && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.target.closest?.('.filter')) {
      e.preventDefault(); // arrows move through the filter menu instead of the list
      const items = [...document.querySelectorAll('.fmenu .fitem')], i = items.indexOf(e.target), down = e.key === 'ArrowDown';
      items[i < 0 ? (down ? 0 : items.length - 1) : (i + (down ? 1 : -1) + items.length) % items.length]?.focus();
      return;
    }
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.target.matches?.('[data-note-text], [data-note-grip]')) {
      e.preventDefault();
      const id = e.target.dataset.id;
      moveNote(id, S.notes.findIndex(n => n.id === id) + (e.key === 'ArrowUp' ? -1 : 1));
      return;
    }
    if (UI.draft && typing && e.target.closest('[data-draft]') && !e.isComposing) {
      if (e.key === 'Escape') { e.preventDefault(); if (!UI.draft.creating) closeDraft(true); return; }
      if (e.key === 'Enter' && e.target.matches('[data-draft-field]')) { e.preventDefault(); createDraft(); return; }
    }
    if (typing && isUndoKey(e)) actions.claimKey(); // in a field the browser does it itself; the menu must not do another one on top
    if (typing) {
      // Editing a note: Enter saves (via change on blur), Esc first restores the old text.
      if (e.target.matches('[data-note-text]') && (e.key === 'Enter' || e.key === 'Escape')) {
        e.preventDefault();
        if (e.key === 'Escape') e.target.value = S.notes.find(n => n.id === e.target.dataset.id)?.text ?? e.target.value;
        e.target.blur();
      } else if (e.target.matches('[data-tracked-filter]') && e.key === 'Escape') {
        if (UI.trackedQuery) { UI.trackedQuery = ''; e.target.value = ''; render(); }
        $('#tracked-filter')?.blur(); // render() replaces the field: blur the new one, otherwise the focus stays stuck in the filter
        e.target.blur();
      } else if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (isUndoKey(e)) { e.preventDefault(); undo('key'); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '?') { e.preventDefault(); UI.help = !UI.help; render(); return; }
    if (UI.help) return; // behind the overview the other keys do nothing
    if (e.key === '/') { e.preventDefault(); focusAdd(); return; }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-action]:not(button)')) { e.preventDefault(); e.target.click(); return; }
    if (isPage(UI.view)) return;
    if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'e' && UI.selected && UI.view !== 'stale' && find(UI.selected) && pending(find(UI.selected)).length) markProcessed([UI.selected]);
    else if (e.key === 'o' && UI.selected && (find(UI.selected) || staleIssue(UI.selected))) api.openInJira(UI.selected);
    else if (e.key === 'u' && UI.selected && UI.view !== 'stale' && find(UI.selected)) untrack(UI.selected);
    else if (e.key === 'Escape' && UI.detailOpen) { UI.detailOpen = false; render(); }
  });

  matchMedia('(min-width: 721px)').addEventListener('change', render);

  // An update from main between mousedown and mouseup replaces the button under the mouse, and the click is lost.
  // Such an update therefore waits until the mouse is released, and at most half a second.
  let pressed = false, deferred = null;
  function flush() {
    if (!deferred) return;
    clearTimeout(deferred);
    deferred = null;
    render();
  }
  document.addEventListener('pointerdown', () => { pressed = true; }, true);
  for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, () => { pressed = false; setTimeout(flush); }, true); // after the click

  let booted = false;
  const earlyUpdates = []; // update announcements that arrived before the first state

  function receive(state) {
    S = state;
    const language = resolveLanguage(state.settings.language, state.env?.locale);
    if (t?.language !== language) { // a new language: every text is redrawn by the render below
      t = createTranslator(language, state.env?.locale);
      document.documentElement.lang = t.language;
      diffMemo.clear(); // the memoized diffs contain words too
    }
    actions.overlay(S); // actions still on their way to main must not be reverted by this push
    if (UI.draft && !UI.draft.creating && !state.notes.some(n => n.id === UI.draft.id)) UI.draft = null; // the note is gone
    const fresh = !booted;
    if (fresh) {
      booted = true;
      UI.staleFilter = state.settings.staleFilter || [];
      if (!configured()) UI.view = 'connect';
    }
    renderSoon();
    if (fresh && UI.view === 'connect') focusConnect(); // first start: put the cursor in the first empty field
    // Announcements that arrived before the first state: main sends each one once, so they wait for the translator.
    for (const r of earlyUpdates.splice(0)) showUpdate(r);
  }

  api.onState(receive);
  api.onFocus(({ key }) => { if (S) focusIssue(key); });
  api.onUpdates(r => { if (S) showUpdate(r); else earlyUpdates.push(r); });
  api.onCommand(cmd => {
    if (!S) return;
    if (cmd === 'add') focusAdd();
    else if (cmd === 'undo') {
      if (isTextField(document.activeElement)) { if (!actions.recentKey()) document.execCommand('undo'); } else undo('menu');
    }
    else if (['settings', 'changed', 'tracked', 'stale', 'notes'].includes(cmd)) setView(cmd);
  });

  setInterval(tick, 1000);
  setInterval(() => { if (!document.hidden) render(); }, 60_000); // update relative times

  api.getState().then(state => { if (!booted) receive(state); });
})();
