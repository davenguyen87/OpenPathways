import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const verifyMod = require('../../src/rebuild/verify.js');
const { verify, compareFindings, __setAuditForTest } = verifyMod;

// Real fs (CJS) so vi.spyOn works for the no-write invariant test. Importing
// via createRequire gives us the same object Node hands to other CJS modules,
// which is mutable for spying — unlike the ESM `import * from 'fs'` namespace.
const fs = require('fs');

function makeAuditResult({ violations, criteriaFailed, criteriaResults }) {
  return {
    packageType: 'scorm12',
    complete: true,
    incompleteReason: null,
    scorecard: {
      wcagVersion: 'WCAG22',
      passed: violations.length === 0,
      score: 100,
      totalCriteria: 50,
      passedCriteria: 50 - criteriaFailed,
      failedCriteria: criteriaFailed,
      totalViolations: violations.length,
      criteriaResults: criteriaResults || []
    },
    violations,
    scos: [],
    manualReview: [],
    dynamicReport: { skipped: false, reason: null, iframeWarnings: [], dynamicViolationsCount: 0 },
    fixesApplied: null
  };
}

function v(criterion, file, line) {
  return { criterion, file, line, message: `violation at ${file}:${line}` };
}

let auditMock;

beforeEach(() => {
  auditMock = vi.fn();
  __setAuditForTest(auditMock);
});

afterEach(() => {
  __setAuditForTest(null);
  vi.restoreAllMocks();
});

describe('verify() — fixture-style roundtrip (mocked audit)', () => {
  it('reports lower after-count, correct resolved, zero introduced, hasRegression=false', async () => {
    const before = makeAuditResult({
      violations: [
        v('1.1.1', 'shared/page-1.html', 10),
        v('1.1.1', 'shared/page-2.html', 20),
        v('1.3.1', 'shared/page-1.html', 30),
        v('2.4.2', 'shared/page-3.html', 5)
      ],
      criteriaFailed: 3,
      criteriaResults: [
        { id: '1.1.1', passed: false },
        { id: '1.3.1', passed: false },
        { id: '2.4.2', passed: false }
      ]
    });

    const after = makeAuditResult({
      violations: [v('2.4.2', 'shared/page-3.html', 5)],
      criteriaFailed: 1,
      criteriaResults: [{ id: '2.4.2', passed: false }]
    });
    auditMock.mockResolvedValueOnce(after);

    const result = await verify('/tmp/fake-rebuilt.zip', before, { standard: 'wcag22' });

    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith('/tmp/fake-rebuilt.zip', expect.objectContaining({ standard: 'wcag22' }));

    expect(result.before).toEqual({ violations: 4, criteriaFailed: 3, section508Failed: 3 });
    expect(result.after).toEqual({ violations: 1, criteriaFailed: 1, section508Failed: 1 });
    expect(result.resolved).toBe(3);
    expect(result.introduced).toBe(0);
    expect(result.remaining).toBe(1);
    expect(result.introducedFindings).toEqual([]);
    expect(result.hasRegression).toBe(false);
  });

  it('passes through standard/packageType/browser/timeoutDynamic/signal to audit()', async () => {
    const empty = makeAuditResult({ violations: [], criteriaFailed: 0, criteriaResults: [] });
    auditMock.mockResolvedValueOnce(empty);

    const signal = new AbortController().signal;
    await verify('/tmp/x.zip', empty, {
      standard: 'wcag21',
      packageType: 'scorm12',
      browser: 'chromium',
      timeoutDynamic: 12345,
      signal
    });

    expect(auditMock).toHaveBeenCalledWith(
      '/tmp/x.zip',
      expect.objectContaining({
        standard: 'wcag21',
        packageType: 'scorm12',
        browser: 'chromium',
        timeoutDynamic: 12345,
        signal
      })
    );
  });

  it('does not mutate the originalAuditResults argument', async () => {
    const before = makeAuditResult({
      violations: [v('1.1.1', 'p.html', 1)],
      criteriaFailed: 1,
      criteriaResults: [{ id: '1.1.1', passed: false }]
    });
    const beforeSnapshot = JSON.stringify(before);
    auditMock.mockResolvedValueOnce(makeAuditResult({ violations: [], criteriaFailed: 0, criteriaResults: [] }));

    await verify('/tmp/x.zip', before);

    expect(JSON.stringify(before)).toBe(beforeSnapshot);
  });
});

describe('verify() — regression case (synthetic)', () => {
  it('flags hasRegression=true and lists the new finding when introduced > 0', async () => {
    const before = makeAuditResult({
      violations: [v('1.1.1', 'page.html', 10)],
      criteriaFailed: 1,
      criteriaResults: [{ id: '1.1.1', passed: false }]
    });
    const introducedFinding = v('1.4.3', 'page.html', 50);
    const after = makeAuditResult({
      violations: [v('1.1.1', 'page.html', 10), introducedFinding],
      criteriaFailed: 2,
      criteriaResults: [
        { id: '1.1.1', passed: false },
        { id: '1.4.3', passed: false }
      ]
    });
    auditMock.mockResolvedValueOnce(after);

    const result = await verify('/tmp/regressed.zip', before);

    expect(result.hasRegression).toBe(true);
    expect(result.introduced).toBe(1);
    expect(result.introducedFindings).toEqual([introducedFinding]);
    expect(result.resolved).toBe(0);
    expect(result.remaining).toBe(2);
  });
});

describe('compareFindings() — pure function', () => {
  it('matches by (criterion, file, line)', () => {
    const a = v('1.1.1', 'p.html', 10);
    const b = v('1.3.1', 'p.html', 20);
    const c = v('1.4.3', 'q.html', 5);
    const result = compareFindings([a, b, c], [a, b, c]);
    expect(result.matched).toHaveLength(3);
    expect(result.resolved).toEqual([]);
    expect(result.introduced).toEqual([]);
  });

  it('treats same criterion + different line as resolved + introduced (renamed-file edge)', () => {
    const beforeF = v('1.1.1', 'p.html', 10);
    const afterF = v('1.1.1', 'p.html', 99);
    const result = compareFindings([beforeF], [afterF]);
    expect(result.matched).toEqual([]);
    expect(result.resolved).toEqual([beforeF]);
    expect(result.introduced).toEqual([afterF]);
  });

  it('treats same criterion + same line + different file as resolved + introduced', () => {
    const beforeF = v('1.1.1', 'old.html', 10);
    const afterF = v('1.1.1', 'new.html', 10);
    const result = compareFindings([beforeF], [afterF]);
    expect(result.matched).toEqual([]);
    expect(result.resolved).toEqual([beforeF]);
    expect(result.introduced).toEqual([afterF]);
  });

  it('multiset matches: 2 before + 1 after at same triple = 1 matched + 1 resolved', () => {
    const dup1 = v('1.1.1', 'p.html', 10);
    const dup2 = v('1.1.1', 'p.html', 10);
    const after = v('1.1.1', 'p.html', 10);
    const result = compareFindings([dup1, dup2], [after]);
    expect(result.matched).toHaveLength(1);
    expect(result.resolved).toHaveLength(1);
    expect(result.introduced).toEqual([]);
  });

  it('treats missing line as null (matches across before/after)', () => {
    const beforeF = { criterion: '1.1.1', file: 'p.html' };
    const afterF = { criterion: '1.1.1', file: 'p.html', line: null };
    const result = compareFindings([beforeF], [afterF]);
    expect(result.matched).toHaveLength(1);
    expect(result.resolved).toEqual([]);
    expect(result.introduced).toEqual([]);
  });

  it('returns shape { resolved, introduced, matched } even on empty input', () => {
    const result = compareFindings([], []);
    expect(result).toEqual({ resolved: [], introduced: [], matched: [] });
  });
});

describe('verify() — no-write invariant', () => {
  it('does not call any fs write API during a run', async () => {
    const writeFileSyncSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('verify must not call fs.writeFileSync');
    });
    const writeFileSpy = vi.spyOn(fs.promises, 'writeFile').mockImplementation(async () => {
      throw new Error('verify must not call fs.promises.writeFile');
    });
    const appendFileSyncSpy = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
      throw new Error('verify must not call fs.appendFileSync');
    });

    const before = makeAuditResult({
      violations: [v('1.1.1', 'p.html', 1)],
      criteriaFailed: 1,
      criteriaResults: [{ id: '1.1.1', passed: false }]
    });
    auditMock.mockResolvedValueOnce(makeAuditResult({ violations: [], criteriaFailed: 0, criteriaResults: [] }));

    await verify('/tmp/x.zip', before);

    expect(writeFileSyncSpy).not.toHaveBeenCalled();
    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(appendFileSyncSpy).not.toHaveBeenCalled();
  });
});

describe('verify() — section 508 derivation', () => {
  it('counts only failed criteria that map to a Section 508 reference', async () => {
    // 1.1.1 maps to 503.4. 1.3.1 maps to 502.2.1. "9.9.9" is fictitious — no mapping.
    const before = makeAuditResult({
      violations: [v('1.1.1', 'a.html', 1), v('1.3.1', 'b.html', 2), v('9.9.9', 'c.html', 3)],
      criteriaFailed: 3,
      criteriaResults: [
        { id: '1.1.1', passed: false },
        { id: '1.3.1', passed: false },
        { id: '9.9.9', passed: false }
      ]
    });
    auditMock.mockResolvedValueOnce(makeAuditResult({ violations: [], criteriaFailed: 0, criteriaResults: [] }));

    const result = await verify('/tmp/x.zip', before);
    expect(result.before.criteriaFailed).toBe(3);
    expect(result.before.section508Failed).toBe(2);
    expect(result.after.section508Failed).toBe(0);
  });
});
