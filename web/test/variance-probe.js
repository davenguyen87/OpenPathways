#!/usr/bin/env node

/**
 * Audit determinism probe.
 *
 * Runs audit() N times on the same fixture and reports:
 *   - score distribution
 *   - total-violations distribution
 *   - distinct violation-set hashes (the meaningful "did we get the same
 *     collection of violations?" signal)
 *   - per-run timing
 *   - the symmetric diff between the most and least common violation sets,
 *     so you can see which checks flipped
 *
 * Usage:
 *   node web/test/variance-probe.js [fixture] [N]
 *   N=20 node web/test/variance-probe.js
 *
 * Defaults: scorm12-clean.zip, N=100.
 *
 * Investigation tool, not a CI gate. Each iteration launches a fresh
 * Playwright Chromium, so wall-clock grows linearly with N.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { audit } = require('../../src/index');

const FIXTURES_DIR = path.resolve(__dirname, '..', '..', 'test', 'fixtures');

// Argument parsing: any numeric arg is N; any non-numeric arg is the fixture.
const args = process.argv.slice(2);
const numericArg = args.find((a) => /^\d+$/.test(a));
const fixtureArg = args.find((a) => !/^\d+$/.test(a));
const N = parseInt(numericArg || process.env.N || '100', 10);
const fixture = fixtureArg
  ? (path.isAbsolute(fixtureArg) ? fixtureArg : path.resolve(fixtureArg))
  : path.join(FIXTURES_DIR, 'scorm12-clean.zip');

if (!fs.existsSync(fixture)) {
  console.error(`Fixture not found: ${fixture}`);
  process.exit(1);
}

// Per-violation identity. Stable across runs because all fields come from
// the static analysis of the fixture or from CDP attributes; we deliberately
// drop SCO link metadata which is just an enrichment.
function violationKey(v) {
  return [v.criterion, v.file || '', v.line || '', v.severity || '', v.message || ''].join('::');
}

function shortHash(input) {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 12);
}

function setHash(keys) {
  return shortHash([...keys].sort().join('\n'));
}

async function main() {
  console.log(`Probe: fixture=${path.basename(fixture)}  N=${N}`);
  console.log('Each iteration runs audit() end-to-end with Playwright. Be patient.\n');

  const runs = [];
  const t0 = Date.now();

  for (let i = 0; i < N; i++) {
    const start = Date.now();
    let result;
    try {
      result = await audit(fixture, {});
    } catch (err) {
      console.error(`[${i + 1}/${N}] FAIL: ${err.message}`);
      runs.push({ ok: false, error: err.message });
      continue;
    }
    const ms = Date.now() - start;
    const keys = result.violations.map(violationKey);
    const hash = setHash(keys);
    runs.push({
      ok: true,
      ms,
      score: result.scorecard.score,
      total: result.scorecard.totalViolations,
      complete: result.complete,
      keys,
      hash,
    });
    process.stdout.write(
      `[${i + 1}/${N}] score=${result.scorecard.score}% violations=${result.scorecard.totalViolations} hash=${hash} ${ms}ms\n`
    );
  }

  const totalMs = Date.now() - t0;
  const ok = runs.filter((r) => r.ok);
  console.log(`\n=== Summary (${ok.length}/${N} ok, ${(totalMs / 1000).toFixed(1)}s total) ===`);

  // Score distribution
  const scoreCounts = new Map();
  for (const r of ok) scoreCounts.set(r.score, (scoreCounts.get(r.score) || 0) + 1);
  console.log('\nScore distribution:');
  [...scoreCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([s, c]) => console.log(`  ${s}%  ×${c}  (${(100 * c / ok.length).toFixed(1)}%)`));

  // Total-violation distribution
  const totalCounts = new Map();
  for (const r of ok) totalCounts.set(r.total, (totalCounts.get(r.total) || 0) + 1);
  console.log('\nTotal-violation count distribution:');
  [...totalCounts.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .forEach(([t, c]) => console.log(`  ${t} violations  ×${c}`));

  // Hash distribution
  const hashGroups = new Map();
  for (const r of ok) {
    if (!hashGroups.has(r.hash)) hashGroups.set(r.hash, { count: 0, sample: r });
    hashGroups.get(r.hash).count++;
  }
  console.log('\nViolation-set hashes (distinct violation collections):');
  [...hashGroups.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .forEach(([h, g]) => console.log(`  ${h}  ×${g.count}  (${(100 * g.count / ok.length).toFixed(1)}%)`));

  // Diff between the two most common sets, if there's variance
  if (hashGroups.size > 1) {
    const sorted = [...hashGroups.entries()].sort((a, b) => b[1].count - a[1].count);
    const [hashA, groupA] = sorted[0];
    const [hashB, groupB] = sorted[1];
    const setA = new Set(groupA.sample.keys);
    const setB = new Set(groupB.sample.keys);
    const onlyA = [...setA].filter((k) => !setB.has(k));
    const onlyB = [...setB].filter((k) => !setA.has(k));
    console.log(`\nDiff: ${hashA} vs ${hashB}`);
    if (onlyA.length) {
      console.log(`  Only in ${hashA} (×${groupA.count}):`);
      onlyA.forEach((k) => console.log(`    + ${k.slice(0, 160)}`));
    }
    if (onlyB.length) {
      console.log(`  Only in ${hashB} (×${groupB.count}):`);
      onlyB.forEach((k) => console.log(`    + ${k.slice(0, 160)}`));
    }
    if (onlyA.length === 0 && onlyB.length === 0) {
      console.log('  (sets are identical — hashes differ for another reason — bug?)');
    }
  }

  // Timing
  const times = ok.map((r) => r.ms).sort((a, b) => a - b);
  if (times.length) {
    const pct = (p) => times[Math.min(times.length - 1, Math.floor(times.length * p))];
    console.log(
      `\nTiming per run: min=${times[0]}ms  p50=${pct(0.5)}ms  p95=${pct(0.95)}ms  max=${times[times.length - 1]}ms`
    );
  }

  // Verdict
  console.log('\nVerdict:');
  if (hashGroups.size === 1) {
    console.log(`  Deterministic across ${ok.length} runs (single violation-set hash).`);
  } else {
    console.log(`  Non-deterministic: ${hashGroups.size} distinct violation sets across ${ok.length} runs.`);
    const [, top] = [...hashGroups.entries()].sort((a, b) => b[1].count - a[1].count)[0];
    console.log(`  Most common set occurred in ${top.count}/${ok.length} runs (${(100 * top.count / ok.length).toFixed(1)}%).`);
  }

  // Dump raw data for further analysis
  const out = path.join(__dirname, 'variance-probe.last.json');
  fs.writeFileSync(out, JSON.stringify({
    fixture: path.basename(fixture), N, totalMs,
    runs: runs.map((r) => r.ok
      ? { ms: r.ms, score: r.score, total: r.total, hash: r.hash, complete: r.complete }
      : { error: r.error }),
  }, null, 2));
  console.log(`\nRaw per-run data: ${out}`);
}

main().catch((err) => {
  console.error('Probe crashed:', err);
  process.exit(1);
});
