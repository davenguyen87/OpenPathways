/**
 * test/lib/rebuild-cli.test.js
 *
 * Unit tests for src/lib/rebuild-cli.js — action functions tested with
 * fully mocked dependencies so no filesystem, network, or Playwright is
 * required.
 *
 * Structure:
 *   rebuildAction — engagement path resolution, audit reuse, artifact write
 *                   order, exit codes, tier dispatch, regression handling.
 *   rebuildLibraryAction — zip discovery, per-package delegation, rollup
 *                          write, exit codes.
 *   CLI shape — `prism rebuild --help` and `prism rebuild-library --help`
 *               list the documented flags.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import { rebuildAction, rebuildLibraryAction } from '../../src/lib/rebuild-cli.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeAuditResults(violationCount = 5) {
  return {
    scorecard: {
      score: 60,
      passed: false,
      failedCriteria: 3,
      criteriaFailed: 3,
      totalCriteria: 10,
      totalViolations: violationCount,
      criteriaResults: [],
    },
    violations: Array.from({ length: violationCount }, (_, i) => ({
      criterion: '1.1.1',
      file: `page-${i}.html`,
      line: i + 1,
    })),
    scos: [],
    manualReview: [],
    dynamicReport: { skipped: false, reason: null, iframeWarnings: [], dynamicViolationsCount: 0 },
    fixesApplied: null,
    packageType: 'scorm12',
    complete: true,
  };
}

function makeManifest(patches = 0, deferred = 0) {
  return {
    schemaVersion: '1.0.0',
    engagementId: 'test-eng',
    packageName: 'test.zip',
    inputZipSha256: 'abc123',
    outputZipSha256: 'def456',
    mode: 'safe',
    standard: 'wcag22',
    createdAt: '2026-05-08T00:00:00Z',
    tool: { name: 'prism', version: '4.0.0' },
    patches: Array.from({ length: patches }, (_, i) => ({
      id: `patch-${String(i + 1).padStart(4, '0')}`,
      fixer: 'add-alt-decorative',
      criterion: '1.1.1',
      triage: 'auto-fix safe',
      tier: 'safe',
      confidence: 'definitive',
      provenance: { source: 'deterministic', timestamp: '2026-05-08T00:00:00Z' },
      file: 'index.html',
      range: { startLine: 1, startCol: 0, endLine: 1, endCol: 10 },
      before: '<img>',
      after: '<img alt="">',
      rationale: 'test',
      reversible: true,
      status: 'applied',
    })),
    deferred: Array.from({ length: deferred }, (_, i) => ({
      criterion: '1.1.1',
      triage: 'auto-fix safe',
      reason: 'no fixer registered',
      file: `page-${i}.html`,
      line: 1,
    })),
    verification: {
      before: { violations: 5, criteriaFailed: 3, section508Failed: 1 },
      after: { violations: 0, criteriaFailed: 0, section508Failed: 0 },
      resolved: 5,
      introduced: 0,
      remaining: 0,
    },
  };
}

function makeVerifyResult(overrides = {}) {
  return {
    before: { violations: 5, criteriaFailed: 3, section508Failed: 1 },
    after: { violations: 0, criteriaFailed: 0, section508Failed: 0 },
    resolved: 5,
    introduced: 0,
    remaining: 0,
    introducedFindings: [],
    hasRegression: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Minimal in-memory fs.promises shim used in tests
// ---------------------------------------------------------------------------

function makeFsp(files = {}) {
  const store = { ...files };
  return {
    mkdir: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockImplementation(async (p) => {
      if (p in store) return { mtimeMs: 1000 };
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    }),
    readFile: vi.fn().mockImplementation(async (p) => {
      if (p in store) return store[p];
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    copyFile: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
  };
}

// ---------------------------------------------------------------------------
// rebuildAction tests
// ---------------------------------------------------------------------------

describe('rebuildAction', () => {
  let exitCode;
  let mockExit;
  let auditResults;
  let manifest;
  let verifyResult;
  let rebuiltZipPath;

  beforeEach(() => {
    exitCode = null;
    mockExit = vi.fn((code) => { exitCode = code; });
    auditResults = makeAuditResults(5);
    manifest = makeManifest(2, 1);
    verifyResult = makeVerifyResult();
    rebuiltZipPath = '/tmp/prism-rebuild-out/test.rebuilt.zip';
  });

  function makeDeps(fspOverride = {}, rebuildReturn = {}) {
    const fsp = makeFsp(fspOverride);
    return {
      fsp,
      exit: mockExit,
      audit: vi.fn().mockResolvedValue(auditResults),
      rebuild: vi.fn().mockResolvedValue({
        manifest,
        rebuiltZipPath: rebuildReturn.rebuiltZipPath !== undefined
          ? rebuildReturn.rebuiltZipPath
          : rebuiltZipPath,
      }),
      verify: vi.fn().mockResolvedValue(verifyResult),
      renderRebuildDiff: vi.fn().mockResolvedValue('<html>diff</html>'),
      renderRebuildSummary: vi.fn().mockResolvedValue('<html>summary</html>'),
    };
  }

  it('exits 2 when --engagement is missing', async () => {
    const deps = makeDeps();
    await rebuildAction('/path/to/test.zip', {}, deps);
    expect(mockExit).toHaveBeenCalledWith(2);
    expect(deps.rebuild).not.toHaveBeenCalled();
  });

  it('exits 0 for --mode assisted without rebuilding', async () => {
    const deps = makeDeps();
    await rebuildAction('/path/to/test.zip', { engagement: 'eng-1', mode: 'assisted' }, deps);
    expect(mockExit).toHaveBeenCalledWith(0);
    expect(deps.rebuild).not.toHaveBeenCalled();
    expect(deps.verify).not.toHaveBeenCalled();
  });

  it('--mode full without --no-checkpoint stages output and exits 0 without verifying', async () => {
    // Commander stores the negated --no-checkpoint as cmdOpts.checkpoint:
    // true (default) means checkpoint-on. Full mode in checkpoint-on calls
    // rebuild() with noCheckpoint=false; the orchestrator returns
    // { manifest, stagedZipPath, stagingDir } and the CLI must NOT call
    // verify(). It must render preview into the staging directory.
    const deps = makeDeps();
    deps.fsp.stat = vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    deps.rebuild = vi.fn().mockResolvedValue({
      manifest,
      stagedZipPath: '/tmp/eng/test/.rebuild-staging/rebuilt-staged.zip',
      stagingDir: '/tmp/eng/test/.rebuild-staging'
    });
    deps.renderRebuildPreview = vi.fn().mockResolvedValue('<html>preview</html>');

    await rebuildAction(
      '/path/to/test.zip',
      { engagement: 'eng-1', mode: 'full', checkpoint: true },
      deps
    );

    expect(deps.rebuild).toHaveBeenCalled();
    const rebuildOpts = deps.rebuild.mock.calls[0][2];
    expect(rebuildOpts.noCheckpoint).toBe(false);
    expect(rebuildOpts.mode).toBe('full');
    // No verify in checkpoint mode — that runs at promote() time.
    expect(deps.verify).not.toHaveBeenCalled();
    // Preview rendered (best-effort; chunk 06 supplies the renderer).
    expect(deps.renderRebuildPreview).toHaveBeenCalled();
    // No final rebuilt.zip copy in checkpoint mode.
    expect(deps.fsp.copyFile).not.toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it('--mode full --no-checkpoint produces final artifacts directly', async () => {
    // --no-checkpoint sets cmdOpts.checkpoint to false. The CLI calls
    // rebuild() with noCheckpoint=true; orchestrator returns the inline
    // rebuilt zip. CLI verifies, renders diff/summary/preview, exits per
    // v4 contract.
    const deps = makeDeps();
    deps.fsp.stat = vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    deps.rebuild = vi.fn().mockResolvedValue({
      manifest,
      rebuiltZipPath
    });
    deps.renderRebuildPreview = vi.fn().mockResolvedValue('<html>preview</html>');

    await rebuildAction(
      '/path/to/test.zip',
      { engagement: 'eng-1', mode: 'full', checkpoint: false },
      deps
    );

    expect(deps.rebuild).toHaveBeenCalled();
    const rebuildOpts = deps.rebuild.mock.calls[0][2];
    expect(rebuildOpts.noCheckpoint).toBe(true);
    expect(deps.verify).toHaveBeenCalled();
    expect(deps.renderRebuildDiff).toHaveBeenCalled();
    expect(deps.renderRebuildSummary).toHaveBeenCalled();
    expect(deps.renderRebuildPreview).toHaveBeenCalled();
    expect(deps.fsp.copyFile).toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it('--mode full --no-checkpoint exits 2 on verification regression', async () => {
    const deps = makeDeps();
    deps.fsp.stat = vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    deps.rebuild = vi.fn().mockResolvedValue({
      manifest,
      rebuiltZipPath
    });
    deps.verify = vi.fn().mockResolvedValue(makeVerifyResult({
      introduced: 2,
      hasRegression: true
    }));
    deps.renderRebuildPreview = vi.fn().mockResolvedValue('<html>preview</html>');

    await rebuildAction(
      '/path/to/test.zip',
      { engagement: 'eng-1', mode: 'full', checkpoint: false },
      deps
    );

    expect(mockExit).toHaveBeenCalledWith(2);
    expect(deps.fsp.copyFile).not.toHaveBeenCalled();
  });

  it('runs audit when no results.json exists, then rebuilds', async () => {
    // fsp.stat throws ENOENT for both the audit results and the input zip.
    const deps = makeDeps();
    deps.fsp.stat = vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    await rebuildAction('/path/to/test.zip', { engagement: 'eng-1', mode: 'safe' }, deps);

    expect(deps.audit).toHaveBeenCalled();
    expect(deps.rebuild).toHaveBeenCalled();
    expect(deps.verify).toHaveBeenCalled();
  });

  it('reuses audit when results.json is newer than input zip', async () => {
    const manifestJson = JSON.stringify(manifest);
    const fspFiles = {
      // results.json at the expected path
      [path.join('./engagements/eng-1/test', 'results.json')]: JSON.stringify(auditResults),
    };
    const deps = makeDeps(fspFiles);
    // Stat: results.json mtime (1000) >= input zip mtime (999) => reuse.
    deps.fsp.stat = vi.fn().mockImplementation(async (p) => {
      if (p.endsWith('results.json')) return { mtimeMs: 1000 };
      return { mtimeMs: 999 }; // input zip is older
    });
    deps.fsp.readFile = vi.fn().mockImplementation(async (p) => {
      if (p.endsWith('results.json')) return JSON.stringify(auditResults);
      if (p.endsWith('rebuild-manifest.json')) return manifestJson;
      if (p.endsWith('brand.json')) return JSON.stringify({});
      return '';
    });

    await rebuildAction('/path/to/test.zip', { engagement: 'eng-1', mode: 'safe' }, deps);

    // Audit should NOT have been called because we reused.
    expect(deps.audit).not.toHaveBeenCalled();
    expect(deps.rebuild).toHaveBeenCalled();
  });

  it('calls verify with explicit allowlist only (no fix: true or extra keys)', async () => {
    const deps = makeDeps();
    deps.fsp.stat = vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    await rebuildAction('/path/to/test.zip', {
      engagement: 'eng-1',
      mode: 'safe',
      standard: 'wcag22',
      packageType: 'scorm12',
      browser: 'chromium',
      timeoutDynamic: '30000',
      fix: true, // This should NOT be forwarded to verify.
    }, deps);

    expect(deps.verify).toHaveBeenCalled();
    const verifyCall = deps.verify.mock.calls[0];
    const verifyOpts = verifyCall[2];
    // Only allowlisted keys: standard, packageType, browser, timeoutDynamic, signal
    expect(verifyOpts).toHaveProperty('standard');
    expect(verifyOpts).toHaveProperty('packageType');
    expect(verifyOpts).toHaveProperty('browser');
    expect(verifyOpts).toHaveProperty('timeoutDynamic');
    expect(verifyOpts).not.toHaveProperty('fix');
  });

  it('writes manifest.verification directly from verify() set-matched counts', async () => {
    const customVerify = makeVerifyResult({ resolved: 3, introduced: 0, remaining: 2 });
    const deps = makeDeps();
    deps.fsp.stat = vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    deps.verify = vi.fn().mockResolvedValue(customVerify);

    await rebuildAction('/path/to/test.zip', { engagement: 'eng-1', mode: 'safe' }, deps);

    // manifest.verification must reflect verify()'s set-matched counts.
    expect(manifest.verification.resolved).toBe(3);
    expect(manifest.verification.remaining).toBe(2);
    expect(manifest.verification.introduced).toBe(0);
  });

  it('does NOT write rebuilt.zip when verify returns hasRegression: true', async () => {
    const deps = makeDeps();
    deps.fsp.stat = vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    deps.verify = vi.fn().mockResolvedValue(makeVerifyResult({
      introduced: 2,
      hasRegression: true,
    }));

    await rebuildAction('/path/to/test.zip', { engagement: 'eng-1', mode: 'safe' }, deps);

    // copyFile should NOT be called (rebuilt.zip must not be written).
    expect(deps.fsp.copyFile).not.toHaveBeenCalled();
    // Exit 2 on regression.
    expect(mockExit).toHaveBeenCalledWith(2);
    // Summary should still be rendered.
    expect(deps.renderRebuildSummary).toHaveBeenCalled();
    // Diff should NOT be rendered (no valid zip).
    expect(deps.renderRebuildDiff).not.toHaveBeenCalled();
  });

  it('exits 0 when remaining === 0 after successful rebuild', async () => {
    const deps = makeDeps();
    deps.fsp.stat = vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    deps.verify = vi.fn().mockResolvedValue(makeVerifyResult({ remaining: 0 }));

    await rebuildAction('/path/to/test.zip', { engagement: 'eng-1', mode: 'safe' }, deps);

    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it('exits 1 when remaining > 0 after successful rebuild (no regression)', async () => {
    const deps = makeDeps();
    deps.fsp.stat = vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    deps.verify = vi.fn().mockResolvedValue(makeVerifyResult({ remaining: 3 }));

    await rebuildAction('/path/to/test.zip', { engagement: 'eng-1', mode: 'safe' }, deps);

    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('writes all four artifacts on successful safe rebuild', async () => {
    const deps = makeDeps();
    deps.fsp.stat = vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    await rebuildAction('/path/to/test.zip', { engagement: 'eng-1', mode: 'safe' }, deps);

    // rebuilt.zip written via copyFile
    expect(deps.fsp.copyFile).toHaveBeenCalled();
    // writeFile called for manifest JSON
    const writeFileCalls = deps.fsp.writeFile.mock.calls;
    const writtenPaths = writeFileCalls.map((c) => c[0]);
    const hasManifest = writtenPaths.some((p) => p.endsWith('rebuild-manifest.json'));
    expect(hasManifest).toBe(true);
    // Diff and summary rendered
    expect(deps.renderRebuildDiff).toHaveBeenCalled();
    expect(deps.renderRebuildSummary).toHaveBeenCalled();
  });

  it('resolves engagement path correctly: engagements/<id>/<package-basename>/', async () => {
    const deps = makeDeps();
    deps.fsp.stat = vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    await rebuildAction('/projects/client/compliance-101.zip', { engagement: 'acme-2026', mode: 'safe' }, deps);

    // The engagement dir argument to mkdir must include the package name without .zip.
    const mkdirCalls = deps.fsp.mkdir.mock.calls;
    const paths = mkdirCalls.map((c) => c[0]);
    const hasCorrectPath = paths.some((p) =>
      p.includes('acme-2026') && p.includes('compliance-101')
    );
    expect(hasCorrectPath).toBe(true);
  });

  it('exits 2 on unexpected error', async () => {
    const deps = makeDeps();
    deps.fsp.stat = vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    deps.rebuild = vi.fn().mockRejectedValue(new Error('unexpected crash'));

    await rebuildAction('/path/to/test.zip', { engagement: 'eng-1', mode: 'safe' }, deps);

    expect(mockExit).toHaveBeenCalledWith(2);
  });
});

// ---------------------------------------------------------------------------
// rebuildLibraryAction tests
// ---------------------------------------------------------------------------

describe('rebuildLibraryAction', () => {
  it('exits 2 when --engagement is missing', async () => {
    const exitFn = vi.fn();
    await rebuildLibraryAction('/some/dir', {}, { exit: exitFn, fsp: makeFsp() });
    expect(exitFn).toHaveBeenCalledWith(2);
  });

  it('exits 0 with warning when no .zip files found', async () => {
    const exitFn = vi.fn();
    const fakeLibrary = vi.fn().mockResolvedValue({
      results: [],
      rollupHtmlPath: '/tmp/_rebuild-rollup.html',
      rollupMdPath: '/tmp/_rebuild-rollup.md',
      totals: { resolved: 0, remaining: 0, introduced: 0 }
    });
    await rebuildLibraryAction(
      '/some/dir',
      { engagement: 'eng-1' },
      { exit: exitFn, rebuildLibrary: fakeLibrary }
    );
    expect(exitFn).toHaveBeenCalledWith(0);
  });

  it('forwards opts and packages to rebuildLibrary', async () => {
    const exitFn = vi.fn();
    const fakeLibrary = vi.fn().mockResolvedValue({
      results: [
        { packageName: 'pkg-a.zip', exitCode: 0, verification: { resolved: 1, remaining: 0, introduced: 0 } },
        { packageName: 'pkg-b.zip', exitCode: 0, verification: { resolved: 1, remaining: 0, introduced: 0 } }
      ],
      rollupHtmlPath: '/tmp/_rebuild-rollup.html',
      rollupMdPath: '/tmp/_rebuild-rollup.md',
      totals: { resolved: 2, remaining: 0, introduced: 0 }
    });
    await rebuildLibraryAction(
      '/some/dir',
      { engagement: 'eng-1', mode: 'safe', standard: 'wcag22' },
      { exit: exitFn, rebuildLibrary: fakeLibrary }
    );
    expect(fakeLibrary).toHaveBeenCalledTimes(1);
    const [calledDir, calledOpts] = fakeLibrary.mock.calls[0];
    expect(calledDir).toBe('/some/dir');
    expect(calledOpts.engagementId).toBe('eng-1');
    expect(calledOpts.mode).toBe('safe');
    expect(calledOpts.standard).toBe('wcag22');
  });

  it('exits 0 when all packages have remaining === 0', async () => {
    const exitFn = vi.fn();
    const fakeLibrary = vi.fn().mockResolvedValue({
      results: [{ packageName: 'pkg-a.zip', exitCode: 0, verification: { resolved: 2, remaining: 0, introduced: 0 } }],
      rollupHtmlPath: '/tmp/_rebuild-rollup.html',
      rollupMdPath: '/tmp/_rebuild-rollup.md',
      totals: { resolved: 2, remaining: 0, introduced: 0 }
    });
    await rebuildLibraryAction(
      '/some/dir',
      { engagement: 'eng-1', mode: 'safe' },
      { exit: exitFn, rebuildLibrary: fakeLibrary }
    );
    expect(exitFn).toHaveBeenCalledWith(0);
  });

  it('exits 1 when any package has remaining > 0 (no error, no regression)', async () => {
    const exitFn = vi.fn();
    const fakeLibrary = vi.fn().mockResolvedValue({
      results: [{ packageName: 'pkg-a.zip', exitCode: 1, verification: { resolved: 2, remaining: 3, introduced: 0 } }],
      rollupHtmlPath: '/tmp/_rebuild-rollup.html',
      rollupMdPath: '/tmp/_rebuild-rollup.md',
      totals: { resolved: 2, remaining: 3, introduced: 0 }
    });
    await rebuildLibraryAction(
      '/some/dir',
      { engagement: 'eng-1', mode: 'safe' },
      { exit: exitFn, rebuildLibrary: fakeLibrary }
    );
    expect(exitFn).toHaveBeenCalledWith(1);
  });

  it('exits 2 when any package has introduced > 0 (regression)', async () => {
    const exitFn = vi.fn();
    const fakeLibrary = vi.fn().mockResolvedValue({
      results: [{ packageName: 'pkg-a.zip', exitCode: 2, verification: { resolved: 3, remaining: 0, introduced: 2 } }],
      rollupHtmlPath: '/tmp/_rebuild-rollup.html',
      rollupMdPath: '/tmp/_rebuild-rollup.md',
      totals: { resolved: 3, remaining: 0, introduced: 2 }
    });
    await rebuildLibraryAction(
      '/some/dir',
      { engagement: 'eng-1', mode: 'safe' },
      { exit: exitFn, rebuildLibrary: fakeLibrary }
    );
    expect(exitFn).toHaveBeenCalledWith(2);
  });

  it('exits 2 when rebuildLibrary throws', async () => {
    const exitFn = vi.fn();
    const fakeLibrary = vi.fn().mockRejectedValue(new Error('disk on fire'));
    await rebuildLibraryAction(
      '/some/dir',
      { engagement: 'eng-1', mode: 'safe' },
      { exit: exitFn, rebuildLibrary: fakeLibrary }
    );
    expect(exitFn).toHaveBeenCalledWith(2);
  });
});

// ---------------------------------------------------------------------------
// CLI shape tests — assert --help output contains expected flags
// ---------------------------------------------------------------------------

// Resolve project root relative to this test file (test/lib/ -> ../..)
const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

describe('CLI shape', () => {
  it('rebuild --help lists required flags and options', async () => {
    const { execSync } = await import('child_process');
    const help = execSync(
      'node src/cli.js rebuild --help',
      { cwd: PROJECT_ROOT, encoding: 'utf8' }
    );
    expect(help).toContain('--engagement');
    expect(help).toContain('--mode');
    expect(help).toContain('--standard');
    expect(help).toContain('wcag22');
    expect(help).toContain('--browser');
    expect(help).toContain('--package-type');
    expect(help).toContain('--timeout-dynamic');
    expect(help).toContain('--brand-config');
  });

  it('rebuild-library --help lists required flags and options', async () => {
    const { execSync } = await import('child_process');
    const help = execSync(
      'node src/cli.js rebuild-library --help',
      { cwd: PROJECT_ROOT, encoding: 'utf8' }
    );
    expect(help).toContain('--engagement');
    expect(help).toContain('--mode');
    expect(help).toContain('--standard');
    expect(help).toContain('wcag22');
    expect(help).toContain('--browser');
    expect(help).toContain('--package-type');
    expect(help).toContain('--timeout-dynamic');
  });
});
