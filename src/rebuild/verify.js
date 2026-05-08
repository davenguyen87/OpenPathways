// Re-audit verification — runs audit() on the rebuilt zip and produces a before/after summary.

/**
 * @typedef {Object} AuditFinding
 * @property {string} criterion
 * @property {string} file
 * @property {number|null} [line]
 *
 * @typedef {Object} VerificationCounts
 * @property {number} violations
 * @property {number} criteriaFailed
 * @property {number} section508Failed
 *
 * @typedef {Object} VerifyResult
 * @property {VerificationCounts} before
 * @property {VerificationCounts} after
 * @property {number} resolved
 * @property {number} introduced
 * @property {number} remaining
 * @property {AuditFinding[]} introducedFindings
 * @property {boolean} hasRegression
 *
 * @typedef {Object} CompareResult
 * @property {AuditFinding[]} resolved
 * @property {AuditFinding[]} introduced
 * @property {AuditFinding[]} matched
 */

const { mapWcagTo508 } = require('../lib/section508.js');

// Lazy-loaded audit reference. Read through a getter so tests can substitute
// a stub by writing to `module.exports.__setAuditForTest`. The production
// code path still resolves the real audit() from src/index.js.
let _auditImpl = null;
function getAudit() {
  if (_auditImpl) return _auditImpl;
  _auditImpl = require('../index.js').audit;
  return _auditImpl;
}

/**
 * Re-run audit() against the rebuilt zip and produce a before/after summary.
 *
 * Read-only on the rebuilt zip; never writes a file. Never mutates the
 * original audit results. Never throws on regression — sets `hasRegression`
 * and lets the caller decide.
 *
 * @param {string} rebuiltZipPath
 * @param {Object} originalAuditResults  result returned by a prior audit() call
 * @param {Object} [opts]                pass-through options for audit()
 * @returns {Promise<VerifyResult>}
 */
async function verify(rebuiltZipPath, originalAuditResults, opts) {
  const o = opts || {};

  const auditOptions = {};
  if (o.standard !== undefined) auditOptions.standard = o.standard;
  if (o.packageType !== undefined) auditOptions.packageType = o.packageType;
  if (o.browser !== undefined) auditOptions.browser = o.browser;
  if (o.timeoutDynamic !== undefined) auditOptions.timeoutDynamic = o.timeoutDynamic;
  if (o.signal !== undefined) auditOptions.signal = o.signal;
  // Be liberal: pass through any extra known/unknown audit options the caller forwards.
  for (const k of Object.keys(o)) {
    if (!(k in auditOptions)) auditOptions[k] = o[k];
  }

  const afterResults = await getAudit()(rebuiltZipPath, auditOptions);

  const before = countsFrom(originalAuditResults);
  const after = countsFrom(afterResults);

  const beforeFindings = Array.isArray(originalAuditResults && originalAuditResults.violations)
    ? originalAuditResults.violations
    : [];
  const afterFindings = Array.isArray(afterResults && afterResults.violations)
    ? afterResults.violations
    : [];

  const cmp = compareFindings(beforeFindings, afterFindings);

  const introduced = cmp.introduced.length;
  return {
    before,
    after,
    resolved: cmp.resolved.length,
    introduced,
    remaining: afterFindings.length,
    introducedFindings: cmp.introduced,
    hasRegression: introduced > 0
  };
}

/**
 * Pure helper: match findings across two audit runs by (criterion, file, line).
 *
 * Multiset-style matching: if before has two findings with the same triple
 * and after has one, one is "matched" and one is "resolved". Same criterion
 * with a different file or different line is treated as not-matched (one
 * resolved + one introduced).
 *
 * @param {AuditFinding[]} before
 * @param {AuditFinding[]} after
 * @returns {CompareResult}
 */
function compareFindings(before, after) {
  const beforeArr = Array.isArray(before) ? before : [];
  const afterArr = Array.isArray(after) ? after : [];

  // Bucket before-findings by their (criterion|file|line) key.
  const buckets = new Map();
  for (const f of beforeArr) {
    const key = keyOf(f);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(f);
  }

  const matched = [];
  const introduced = [];

  for (const f of afterArr) {
    const key = keyOf(f);
    const bucket = buckets.get(key);
    if (bucket && bucket.length > 0) {
      // Pair this after-finding with one before-finding from the bucket.
      matched.push(bucket.shift());
    } else {
      introduced.push(f);
    }
  }

  // Anything left in any bucket is a before-finding with no after-finding match.
  const resolved = [];
  for (const bucket of buckets.values()) {
    for (const f of bucket) resolved.push(f);
  }

  return { resolved, introduced, matched };
}

/**
 * Build a (criterion|file|line) key for matching. Missing line becomes null.
 */
function keyOf(finding) {
  const criterion = finding && finding.criterion != null ? String(finding.criterion) : '';
  const file = finding && finding.file != null ? String(finding.file) : '';
  const line = finding && finding.line != null ? finding.line : null;
  return `${criterion}|${file}|${line === null ? '' : line}`;
}

/**
 * Compute { violations, criteriaFailed, section508Failed } from one audit
 * result. `violations` is the length of the violations array. `criteriaFailed`
 * is `scorecard.failedCriteria`. `section508Failed` is the count of failed
 * criteria whose IDs map to a Section 508 reference (per src/lib/section508.js).
 */
function countsFrom(auditResults) {
  const r = auditResults || {};
  const violations = Array.isArray(r.violations) ? r.violations.length : 0;
  const sc = r.scorecard || {};
  const criteriaFailed = typeof sc.failedCriteria === 'number' ? sc.failedCriteria : 0;

  let section508Failed = 0;
  if (Array.isArray(sc.criteriaResults)) {
    for (const c of sc.criteriaResults) {
      if (c && c.passed === false && c.id && mapWcagTo508(c.id) !== null) {
        section508Failed += 1;
      }
    }
  }

  return { violations, criteriaFailed, section508Failed };
}

// Test seam — exported on purpose. Tests pass a stub here to avoid
// invoking the real audit() (which would spawn Playwright). Calling with a
// falsy value clears the override so the next getAudit() re-resolves the
// real implementation.
function __setAuditForTest(impl) {
  _auditImpl = impl || null;
}

module.exports = { verify, compareFindings, __setAuditForTest };
