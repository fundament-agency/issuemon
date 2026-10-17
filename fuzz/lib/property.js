'use strict';
/* Helpers for writing properties: a failure with a stable kind (shrinking keeps to it) and a few comparisons. */

const util = require('node:util');

/** A property violation. `kind` names the broken rule; shrinking only accepts inputs that break the same rule. */
class Violation extends Error {
  constructor(kind, message, details) {
    super(message);
    this.name = 'Violation';
    this.kind = kind;
    this.details = details;
  }
}

const fail = (kind, message, details) => { throw new Violation(kind, message, details); };

/** The kind of any error: a Violation's own kind, else the error type and where in src/ it was thrown. */
function kindOf(err) {
  if (err instanceof Violation) return err.kind;
  const frame = String(err?.stack || '').split('\n').find(line => /[/\\]src[/\\]/.test(line)) || '';
  const where = /([^/\\]+\.js):(\d+)/.exec(frame);
  return `crash:${err?.name || 'Error'}${where ? `@${where[1]}:${where[2]}` : ''}`;
}

const show = value => util.inspect(value, { depth: 8, breakLength: 120, maxStringLength: 400, maxArrayLength: 60 });

/** Deep equality as assert.deepStrictEqual sees it, without throwing. */
function same(a, b) {
  return util.isDeepStrictEqual(a, b);
}

module.exports = { Violation, fail, kindOf, show, same };
