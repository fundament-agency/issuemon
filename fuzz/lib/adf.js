'use strict';
/* Random Atlassian Document Format documents, shaped like the ADF schema (content arrays, string attributes). */

const MENTION_IDS = ['acc-me', 'acc-alex', 'acc-sam', '712020:0f6c-me'];

/** Timestamps a date node may carry. The schema only asks for a string; `robust` adds strings that are no valid date. */
const timestampOf = (r, robust) => (robust && r.bool(0.5)
  ? r.pick(['abc', ' ', '1e3', '9'.repeat(17), '-8640000000000001', '8640000000000001', '12.5', '0x10', 'NaN', 'Infinity'])
  : String(r.int(0, 4_102_444_800_000)));

function inline(r, robust) {
  return r.weighted([
    [7, () => ({ type: 'text', text: r.text(5) || 'x', ...(r.bool(0.2) && { marks: [{ type: r.pick(['strong', 'em', 'code']) }] }) })],
    [2, () => ({ type: 'mention', attrs: { id: r.pick(MENTION_IDS), ...(r.bool(0.9) && { text: `@${r.plainText(2) || 'Sam'}` }), accessLevel: '' } })],
    [1, () => ({ type: 'hardBreak' })],
    [1, () => ({ type: 'emoji', attrs: { shortName: ':smile:', ...(r.bool(0.5) && { text: '😄' }) } })],
    [1, () => ({ type: 'inlineCard', attrs: { url: `https://example.com/${r.string('abc', 1, 4)}` } })],
    [1, () => ({ type: 'status', attrs: { text: r.plainText(2), color: 'green', localId: 'x' } })],
    [1, () => ({ type: 'date', attrs: { timestamp: timestampOf(r, robust) } })],
  ]);
}

const paragraph = (r, robust) => ({ type: 'paragraph', content: r.array(() => inline(r, robust), 0, 5) });

function block(r, depth, robust) {
  const deeper = depth < 3;
  const list = type => ({
    type,
    ...(type === 'orderedList' && { attrs: { order: 1 } }),
    content: r.array(() => ({
      type: 'listItem',
      content: [paragraph(r, robust), ...(deeper && r.bool(0.2) ? [block(r, depth + 1, robust)] : [])],
    }), 1, 4),
  });
  return r.weighted([
    [6, () => paragraph(r, robust)],
    [1, () => ({ type: 'heading', attrs: { level: r.int(1, 6) }, content: r.array(() => inline(r, robust), 0, 3) })],
    [1, () => ({ type: 'blockquote', content: r.array(() => paragraph(r, robust), 1, 2) })],
    [1, () => ({ type: 'codeBlock', attrs: { language: 'js' }, content: [{ type: 'text', text: r.text(6) || 'x' }] })],
    [1, () => ({ type: 'panel', attrs: { panelType: 'info' }, content: r.array(() => paragraph(r, robust), 1, 2) })],
    [deeper ? 2 : 0, () => list(r.pick(['bulletList', 'orderedList']))],
    [1, () => ({ type: 'rule' })],
    [1, () => ({ type: 'mediaSingle', attrs: { layout: 'center' }, content: [{ type: 'media', attrs: { id: 'x', type: 'file', collection: '' } }] })],
    [deeper ? 1 : 0, () => ({
      type: 'table',
      content: r.array(() => ({
        type: 'tableRow',
        content: r.array(() => ({ type: r.pick(['tableCell', 'tableHeader']), attrs: {}, content: r.array(() => paragraph(r, robust), 1, 2) }), 1, 3),
      }), 1, 3),
    })],
  ]);
}

/** A comment body or description. */
const docOf = (r, { robust = false } = {}) => ({ type: 'doc', version: 1, content: r.array(() => block(r, 0, robust), 0, 5) });

/** Every node of a document, depth first. */
function* nodes(node) {
  if (!node || typeof node !== 'object') return;
  yield node;
  for (const kid of node.content || []) yield* nodes(kid);
}

module.exports = { docOf, nodes, MENTION_IDS };
