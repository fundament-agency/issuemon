#!/usr/bin/env node
'use strict';
/* IssueMon fuzzer: property-based tests with random, seeded inputs, plus shrinking of a failing input.
 *
 *   npm run fuzz                                 every property, random seed
 *   npm run fuzz -- --seed 42 --runs 5           fixed seed, five times as many cases
 *   npm run fuzz -- --only diff,keys             properties whose name contains "diff" or "keys"
 *   npm run fuzz -- --only tracker.faults --replay 123456789   one case again, by its case seed
 *   npm run fuzz -- --all                        keep going after a failure: every distinct broken rule per property
 *   npm run fuzz -- --list                       the properties
 *   npm run fuzz -- --no-shrink                  report the first failing input as it was generated
 *
 * Every property lives in fuzz/targets/. A failure prints the broken rule, the case seed, the shrunk input and the
 * command to replay it. The exit code is 1 when any property failed. */

const path = require('node:path');
const fs = require('node:fs');
const { createRng, hash } = require('./lib/rng');
const { shrink } = require('./lib/shrink');
const { kindOf, show } = require('./lib/property');

function parseArgs(argv) {
  const opts = { seed: null, runs: 1, only: [], replay: null, shrink: true, list: false, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => argv[++i];
    if (a === '--seed') opts.seed = Number(value()) >>> 0;
    else if (a === '--runs') opts.runs = Math.max(0.01, Number(value()) || 1);
    else if (a === '--only') opts.only.push(...value().split(',').filter(Boolean));
    else if (a === '--replay') opts.replay = Number(value()) >>> 0;
    else if (a === '--no-shrink') opts.shrink = false;
    else if (a === '--list') opts.list = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown option ${a}`);
  }
  return opts;
}

function loadProperties() {
  const dir = path.join(__dirname, 'targets');
  return fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()
    .flatMap(f => require(path.join(dir, f)).properties);
}

/** Runs one case; returns the error, or null when the property holds. */
async function runCase(prop, input) {
  try {
    await prop.check(input);
    return null;
  } catch (err) {
    return err;
  }
}

/** Runs the cases of one property. Returns the failures, one per broken rule (only the first one without --all). */
async function runProperty(prop, opts, baseSeed) {
  const runs = opts.replay != null ? 1 : Math.max(1, Math.round(prop.runs * opts.runs));
  const started = Date.now();
  const failures = [];
  const kinds = new Set();
  for (let i = 0; i < runs; i++) {
    const caseSeed = opts.replay ?? hash(`${baseSeed}:${prop.name}:${i}`);
    const input = prop.gen(createRng(caseSeed));
    const err = await runCase(prop, input);
    if (!err) continue;
    const kind = kindOf(err);
    if (kinds.has(kind)) continue;
    kinds.add(kind);
    let shrunk = { input, error: err, steps: 0 };
    if (opts.shrink && !prop.noShrink) {
      const result = await shrink(input, candidate => runCase(prop, candidate), kind, { kindOf, maxTries: prop.shrinkTries ?? 400, valid: prop.valid });
      if (result.error) shrunk = result;
    }
    failures.push({ kind, caseSeed, case: i, input, shrunk });
    if (!opts.all) break;
  }
  return { ok: !failures.length, prop, runs, failures, ms: Date.now() - started };
}

function report(result, baseSeed) {
  const { prop } = result;
  if (result.ok) {
    console.log(`  ✓ ${prop.name}  (${result.runs} cases, ${result.ms} ms)`);
    return;
  }
  for (const failure of result.failures) {
    const { shrunk } = failure;
    const err = shrunk.error;
    console.log(`  ✗ ${prop.name}  — ${failure.kind}`);
    console.log(`    ${prop.description}`);
    console.log(`    ${String(err.message).split('\n').join('\n    ')}`);
    if (err.details !== undefined) console.log(`    details: ${show(err.details).split('\n').join('\n    ')}`);
    if (!err.details && err.stack && err.name !== 'Violation') console.log(`    ${err.stack.split('\n').slice(1, 4).join('\n    ')}`);
    const shown = prop.show ? prop.show(shrunk.input) : show(shrunk.input);
    console.log(`    input (shrunk in ${shrunk.steps} steps): ${shown.split('\n').join('\n    ')}`);
    console.log(`    replay: npm run fuzz -- --only ${prop.name} --replay ${failure.caseSeed}   (case ${failure.case} of seed ${baseSeed})`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    const header = fs.readFileSync(__filename, 'utf8').split('/*')[1].split('*/')[0];
    console.log(header.split('\n').map(line => line.replace(/^ \* ?/, '')).join('\n').trim());
    return;
  }
  const all = loadProperties();
  const props = opts.only.length ? all.filter(p => opts.only.some(o => p.name.includes(o))) : all;
  if (opts.list) {
    for (const p of all) console.log(`${p.name.padEnd(28)} ${p.description}`);
    return;
  }
  if (!props.length) throw new Error(`No property matches ${opts.only.join(', ')}`);
  if (opts.replay != null && props.length !== 1) throw new Error('--replay needs --only with exactly one property');
  const baseSeed = opts.seed ?? (Date.now() >>> 0);
  console.log(`IssueMon fuzzer — seed ${baseSeed}, ${props.length} properties`);
  let failed = 0;
  for (const prop of props) {
    const result = await runProperty(prop, opts, baseSeed);
    report(result, baseSeed);
    if (!result.ok) failed++;
  }
  console.log(failed ? `\n${failed} of ${props.length} properties failed (seed ${baseSeed}).` : `\nAll ${props.length} properties held (seed ${baseSeed}).`);
  for (const p of props) await p.teardown?.();
  process.exitCode = failed ? 1 : 0;
}

main().catch(err => {
  console.error(err);
  process.exitCode = 2;
});
