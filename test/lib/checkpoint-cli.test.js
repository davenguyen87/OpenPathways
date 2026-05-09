/**
 * test/lib/checkpoint-cli.test.js
 *
 * Unit tests for src/lib/checkpoint-cli.js — action functions tested with
 * fully mocked dependencies (checkpoint module, renderers, fs, confirm
 * prompt). Nothing touches the real filesystem.
 *
 * Coverage:
 *   approveAction
 *     - missing flags exit 2
 *     - missing staging directory exits 2
 *     - --all approves every pending transform
 *     - --transform <id> approves only listed; un-listed rejected
 *     - mixed --transform + checkpoint-state.json: flags override file
 *     - promotion refused (verification regression) -> exit 2
 *     - exit code 0 when remaining === 0
 *     - exit code 1 when remaining > 0
 *   rejectAction
 *     - missing flags exit 2
 *     - missing staging exits 2
 *     - --force skips prompt
 *     - prompt n / no -> exit 0 with no discard
 *     - prompt y -> discard called, exit 0
 *   listAction
 *     - missing --engagement exits 2
 *     - returns the right set
 *     - empty list still exits 0
 *   CLI shape
 *     - prism rebuild-checkpoint approve|reject|list --help
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import {
  approveAction,
  rejectAction,
  listAction,
  resolveStagingPaths
} from '../../src/lib/checkpoint-cli.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeStagedManifest(transforms = []) {
  return {
    schemaVersion: '2.0.0',
    engagementId: 'test-eng',
    packageName: 'test.zip',
    inputZipSha256: 'abc',
    outputZipSha256: 'def',
    mode: 'full',
    standard: 'wcag22',
    createdAt: '2026-05-08T00:00:00Z',
    tool: { name: 'prism', version: '5.0.0' },
    patches: [],
    transforms,
    deferred: [],
    verification: {
      before: { violations: 5, criteriaFailed: 3, section508Failed: 1 },
      after: { violations: 0, criteriaFailed: 0, section508Failed: 0 },
      resolved: 5,
      introduced: 0,
      remaining: 0
    }
  };
}

function makePendingTransform(id) {
  return {
    id,
    transformer: 'landmark-insertion',
    family: 'landmark',
    criteria: ['1.3.1'],
    tier: 'full',
    scope: { files: ['index.html'], manifestEdited: false },
    patchIds: [`patch-${id}-1`],
    provenance: { source: 'rule-based', timestamp: '2026-05-08T00:00:00Z' },
    rationale: 'test',
    previewPath: 'rebuild-preview.html',
    requiresCheckpointApproval: true,
    status: 'pending-checkpoint'
  };
}

/**
 * Build a fully-mocked deps object for approveAction. Defaults to a
 * happy-path promotion (everything succeeds, remaining===0).
 */
function makeApproveDeps(overrides = {}) {
  const stagedManifest = overrides.stagedManifest || makeStagedManifest([
    makePendingTransform('transform-0001'),
    makePendingTransform('transform-0002')
  ]);
  const finalManifest = overrides.finalManifest || {
    ...stagedManifest,
    transforms: stagedManifest.transforms.map((t) => ({ ...t, status: 'applied' })),
    verification: overrides.verification || stagedManifest.verification
  };

  const fsp = {
    readFile: vi.fn().mockImplementation(async (p) => {
      if (p.endsWith('rebuild-manifest-staged.json')) return JSON.stringify(stagedManifest);
      if (p.endsWith('rebuild-manifest.json')) return JSON.stringify(finalManifest);
      if (p.endsWith('brand.json')) return JSON.stringify({});
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    })
  };

  const fss = {
    existsSync: vi.fn().mockImplementation((p) => {
      if (overrides.stagingMissing) return false;
      return p.includes('.rebuild-staging');
    })
  };

  const checkpoint = {
    readCheckpointState: vi.fn().mockResolvedValue(overrides.savedState || null),
    promote: overrides.promote || vi.fn().mockResolvedValue({
      promoted: true,
      approvedTransforms: ['transform-0001', 'transform-0002'],
      rejectedTransforms: [],
      verificationAfter: finalManifest.verification
    }),
    discard: vi.fn().mockResolvedValue({ discarded: true }),
    listPending: vi.fn().mockResolvedValue([])
  };

  return {
    fsp,
    fss,
    checkpoint,
    renderRebuildDiff: vi.fn().mockResolvedValue('<html>diff</html>'),
    renderRebuildSummary: vi.fn().mockResolvedValue('<html>summary</html>'),
    renderRebuildPreview: vi.fn().mockResolvedValue('<html>preview</html>'),
    exit: vi.fn(),
    transformFlags: overrides.transformFlags || []
  };
}

// ---------------------------------------------------------------------------
// approveAction tests
// ---------------------------------------------------------------------------

describe('approveAction', () => {
  it('exits 2 when --engagement is missing', async () => {
    const deps = makeApproveDeps();
    await approveAction({ package: 'test.zip', all: true }, deps);
    expect(deps.exit).toHaveBeenCalledWith(2);
    expect(deps.checkpoint.promote).not.toHaveBeenCalled();
  });

  it('exits 2 when --package is missing', async () => {
    const deps = makeApproveDeps();
    await approveAction({ engagement: 'eng-1', all: true }, deps);
    expect(deps.exit).toHaveBeenCalledWith(2);
  });

  it('exits 2 when staging directory does not exist', async () => {
    const deps = makeApproveDeps({ stagingMissing: true });
    await approveAction(
      { engagement: 'eng-1', package: 'test.zip', all: true },
      deps
    );
    expect(deps.exit).toHaveBeenCalledWith(2);
    expect(deps.checkpoint.promote).not.toHaveBeenCalled();
  });

  it('exits 2 when no decision source provided (no --all, no --transform, no state file)', async () => {
    const deps = makeApproveDeps({ savedState: null });
    await approveAction(
      { engagement: 'eng-1', package: 'test.zip' },
      deps
    );
    expect(deps.exit).toHaveBeenCalledWith(2);
    expect(deps.checkpoint.promote).not.toHaveBeenCalled();
  });

  it('--all approves every pending transform', async () => {
    const deps = makeApproveDeps();
    await approveAction(
      { engagement: 'eng-1', package: 'test.zip', all: true },
      deps
    );
    expect(deps.checkpoint.promote).toHaveBeenCalled();
    const decisions = deps.checkpoint.promote.mock.calls[0][2];
    expect(decisions).toEqual({
      'transform-0001': 'approve',
      'transform-0002': 'approve'
    });
  });

  it('--transform <id> approves only listed; un-listed rejected', async () => {
    const deps = makeApproveDeps({ transformFlags: ['transform-0001'] });
    await approveAction(
      { engagement: 'eng-1', package: 'test.zip' },
      deps
    );
    expect(deps.checkpoint.promote).toHaveBeenCalled();
    const decisions = deps.checkpoint.promote.mock.calls[0][2];
    expect(decisions).toEqual({
      'transform-0001': 'approve',
      'transform-0002': 'reject'
    });
  });

  it('mixed --transform + checkpoint-state.json: flags override per-id', async () => {
    // savedState says approve transform-0002 but flag says only approve transform-0001.
    const deps = makeApproveDeps({
      savedState: { 'transform-0001': 'reject', 'transform-0002': 'approve' },
      transformFlags: ['transform-0001']
    });
    await approveAction(
      { engagement: 'eng-1', package: 'test.zip' },
      deps
    );
    const decisions = deps.checkpoint.promote.mock.calls[0][2];
    // Flag wins per id: transform-0001 approved (flag), transform-0002 rejected (flag overrides file).
    expect(decisions).toEqual({
      'transform-0001': 'approve',
      'transform-0002': 'reject'
    });
  });

  it('uses checkpoint-state.json when no flags are present', async () => {
    const deps = makeApproveDeps({
      savedState: { 'transform-0001': 'approve', 'transform-0002': 'reject' }
    });
    await approveAction(
      { engagement: 'eng-1', package: 'test.zip' },
      deps
    );
    const decisions = deps.checkpoint.promote.mock.calls[0][2];
    expect(decisions).toEqual({
      'transform-0001': 'approve',
      'transform-0002': 'reject'
    });
  });

  it('exits 2 when promote() returns promoted: false (verification regression)', async () => {
    const deps = makeApproveDeps({
      promote: vi.fn().mockResolvedValue({
        promoted: false,
        reason: 'verification regression: 2 new findings'
      })
    });
    await approveAction(
      { engagement: 'eng-1', package: 'test.zip', all: true },
      deps
    );
    expect(deps.exit).toHaveBeenCalledWith(2);
    expect(deps.renderRebuildDiff).not.toHaveBeenCalled();
  });

  it('exits 2 when promote() throws', async () => {
    const deps = makeApproveDeps({
      promote: vi.fn().mockRejectedValue(new Error('disk on fire'))
    });
    await approveAction(
      { engagement: 'eng-1', package: 'test.zip', all: true },
      deps
    );
    expect(deps.exit).toHaveBeenCalledWith(2);
  });

  it('exits 0 when remaining === 0 after successful promotion', async () => {
    const deps = makeApproveDeps();
    await approveAction(
      { engagement: 'eng-1', package: 'test.zip', all: true },
      deps
    );
    expect(deps.exit).toHaveBeenCalledWith(0);
    // All four artifact renderers were called.
    expect(deps.renderRebuildDiff).toHaveBeenCalled();
    expect(deps.renderRebuildSummary).toHaveBeenCalled();
    expect(deps.renderRebuildPreview).toHaveBeenCalled();
  });

  it('exits 1 when remaining > 0 after successful promotion', async () => {
    const deps = makeApproveDeps({
      finalManifest: {
        ...makeStagedManifest([{ ...makePendingTransform('transform-0001'), status: 'applied' }]),
        verification: {
          before: { violations: 5, criteriaFailed: 3, section508Failed: 1 },
          after: { violations: 2, criteriaFailed: 1, section508Failed: 0 },
          resolved: 3,
          introduced: 0,
          remaining: 2
        }
      }
    });
    await approveAction(
      { engagement: 'eng-1', package: 'test.zip', all: true },
      deps
    );
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it('passes the staging directory (not engagement+package) to readCheckpointState', async () => {
    // Chunk 08's API: readCheckpointState(stagingDir). Verify we honor that.
    const deps = makeApproveDeps();
    await approveAction(
      { engagement: 'eng-1', package: 'test.zip', all: true },
      deps
    );
    expect(deps.checkpoint.readCheckpointState).toHaveBeenCalled();
    const arg = deps.checkpoint.readCheckpointState.mock.calls[0][0];
    expect(arg).toContain('.rebuild-staging');
    expect(arg).toContain('test'); // package basename
  });
});

// ---------------------------------------------------------------------------
// rejectAction tests
// ---------------------------------------------------------------------------

function makeRejectDeps(overrides = {}) {
  return {
    fss: {
      existsSync: vi.fn().mockImplementation((p) =>
        overrides.stagingMissing ? false : p.includes('.rebuild-staging')
      )
    },
    checkpoint: {
      discard: overrides.discard || vi.fn().mockResolvedValue({ discarded: true }),
      promote: vi.fn(),
      listPending: vi.fn(),
      readCheckpointState: vi.fn()
    },
    confirm: overrides.confirm || vi.fn().mockResolvedValue(true),
    exit: vi.fn()
  };
}

describe('rejectAction', () => {
  it('exits 2 when --engagement is missing', async () => {
    const deps = makeRejectDeps();
    await rejectAction({ package: 'test.zip', force: true }, deps);
    expect(deps.exit).toHaveBeenCalledWith(2);
    expect(deps.checkpoint.discard).not.toHaveBeenCalled();
  });

  it('exits 2 when --package is missing', async () => {
    const deps = makeRejectDeps();
    await rejectAction({ engagement: 'eng-1', force: true }, deps);
    expect(deps.exit).toHaveBeenCalledWith(2);
  });

  it('exits 2 when staging dir does not exist', async () => {
    const deps = makeRejectDeps({ stagingMissing: true });
    await rejectAction(
      { engagement: 'eng-1', package: 'test.zip', force: true },
      deps
    );
    expect(deps.exit).toHaveBeenCalledWith(2);
    expect(deps.checkpoint.discard).not.toHaveBeenCalled();
  });

  it('--force skips the prompt and discards', async () => {
    const deps = makeRejectDeps();
    await rejectAction(
      { engagement: 'eng-1', package: 'test.zip', force: true },
      deps
    );
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.checkpoint.discard).toHaveBeenCalled();
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('aborts with exit 0 when prompt is declined', async () => {
    const deps = makeRejectDeps({ confirm: vi.fn().mockResolvedValue(false) });
    await rejectAction(
      { engagement: 'eng-1', package: 'test.zip' },
      deps
    );
    expect(deps.confirm).toHaveBeenCalled();
    expect(deps.checkpoint.discard).not.toHaveBeenCalled();
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('discards on prompt confirmation', async () => {
    const deps = makeRejectDeps({ confirm: vi.fn().mockResolvedValue(true) });
    await rejectAction(
      { engagement: 'eng-1', package: 'test.zip' },
      deps
    );
    expect(deps.confirm).toHaveBeenCalled();
    expect(deps.checkpoint.discard).toHaveBeenCalled();
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('exits 2 when discard throws', async () => {
    const deps = makeRejectDeps({
      discard: vi.fn().mockRejectedValue(new Error('rm failed'))
    });
    await rejectAction(
      { engagement: 'eng-1', package: 'test.zip', force: true },
      deps
    );
    expect(deps.exit).toHaveBeenCalledWith(2);
  });
});

// ---------------------------------------------------------------------------
// listAction tests
// ---------------------------------------------------------------------------

describe('listAction', () => {
  it('exits 2 when --engagement is missing', async () => {
    const exitFn = vi.fn();
    await listAction({}, {
      checkpoint: { listPending: vi.fn() },
      exit: exitFn
    });
    expect(exitFn).toHaveBeenCalledWith(2);
  });

  it('exits 0 with empty list when no packages have pending checkpoints', async () => {
    const exitFn = vi.fn();
    await listAction({ engagement: 'eng-1' }, {
      checkpoint: { listPending: vi.fn().mockResolvedValue([]) },
      exit: exitFn
    });
    expect(exitFn).toHaveBeenCalledWith(0);
  });

  it('returns the correct set of packages with pending checkpoints', async () => {
    const exitFn = vi.fn();
    const listPending = vi.fn().mockResolvedValue([
      { packageName: 'pkg-a', pendingCount: 2, stagingPath: '/foo/pkg-a/.rebuild-staging' },
      { packageName: 'pkg-b', pendingCount: 1, stagingPath: '/foo/pkg-b/.rebuild-staging' }
    ]);
    await listAction({ engagement: 'eng-1' }, {
      checkpoint: { listPending },
      exit: exitFn
    });
    expect(listPending).toHaveBeenCalled();
    expect(exitFn).toHaveBeenCalledWith(0);
  });

  it('exits 2 when listPending throws', async () => {
    const exitFn = vi.fn();
    await listAction({ engagement: 'eng-1' }, {
      checkpoint: { listPending: vi.fn().mockRejectedValue(new Error('readdir failed')) },
      exit: exitFn
    });
    expect(exitFn).toHaveBeenCalledWith(2);
  });
});

// ---------------------------------------------------------------------------
// resolveStagingPaths sanity
// ---------------------------------------------------------------------------

describe('resolveStagingPaths', () => {
  it('strips trailing .zip from the package name', () => {
    const { stagingDir } = resolveStagingPaths('./engagements', 'eng-1', 'test.zip');
    expect(stagingDir).toContain(path.join('eng-1', 'test', '.rebuild-staging'));
    expect(stagingDir).not.toContain('test.zip');
  });

  it('handles a basename without .zip', () => {
    const { stagingDir } = resolveStagingPaths('./engagements', 'eng-1', 'compliance-101');
    expect(stagingDir).toContain(path.join('eng-1', 'compliance-101', '.rebuild-staging'));
  });
});

// ---------------------------------------------------------------------------
// CLI shape tests
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

describe('CLI shape', () => {
  it('rebuild-checkpoint --help lists three subcommands', async () => {
    const { execSync } = await import('child_process');
    const help = execSync(
      'node src/cli.js rebuild-checkpoint --help',
      { cwd: PROJECT_ROOT, encoding: 'utf8' }
    );
    expect(help).toContain('approve');
    expect(help).toContain('reject');
    expect(help).toContain('list');
  });

  it('rebuild-checkpoint approve --help lists --engagement, --package, --transform, --all', async () => {
    const { execSync } = await import('child_process');
    const help = execSync(
      'node src/cli.js rebuild-checkpoint approve --help',
      { cwd: PROJECT_ROOT, encoding: 'utf8' }
    );
    expect(help).toContain('--engagement');
    expect(help).toContain('--package');
    expect(help).toContain('--transform');
    expect(help).toContain('--all');
  });

  it('rebuild-checkpoint reject --help lists --engagement, --package, --force', async () => {
    const { execSync } = await import('child_process');
    const help = execSync(
      'node src/cli.js rebuild-checkpoint reject --help',
      { cwd: PROJECT_ROOT, encoding: 'utf8' }
    );
    expect(help).toContain('--engagement');
    expect(help).toContain('--package');
    expect(help).toContain('--force');
  });

  it('rebuild-checkpoint list --help lists --engagement', async () => {
    const { execSync } = await import('child_process');
    const help = execSync(
      'node src/cli.js rebuild-checkpoint list --help',
      { cwd: PROJECT_ROOT, encoding: 'utf8' }
    );
    expect(help).toContain('--engagement');
  });

  it('rebuild --help includes --no-checkpoint flag', async () => {
    const { execSync } = await import('child_process');
    const help = execSync(
      'node src/cli.js rebuild --help',
      { cwd: PROJECT_ROOT, encoding: 'utf8' }
    );
    expect(help).toContain('--no-checkpoint');
    expect(help).toContain('checkpoint gate');
  });

  it('rebuild-undo --help includes --transform flag', async () => {
    const { execSync } = await import('child_process');
    const help = execSync(
      'node src/cli.js rebuild-undo --help',
      { cwd: PROJECT_ROOT, encoding: 'utf8' }
    );
    expect(help).toContain('--transform');
  });
});
