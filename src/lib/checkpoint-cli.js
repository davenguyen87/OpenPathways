/**
 * checkpoint-cli.js — CLI registration helpers for `prism rebuild-checkpoint`
 * (v5). Mirrors the structure of `src/lib/rebuild-cli.js` so the action
 * functions can be unit-tested without spinning up Commander or touching the
 * real filesystem.
 *
 * Subcommands:
 *   approve --engagement <id> --package <name> [--transform <id>...] [--all]
 *   reject  --engagement <id> --package <name> [--force]
 *   list    --engagement <id>
 *
 * Exit codes (set via `deps.exit` or `process.exit` fallback):
 *   0 — success / verified clean post-approval / list / abort-on-prompt
 *   1 — promotion succeeded but verification.remaining > 0
 *   2 — tool error / regression rolled back / missing flags / no staging
 *
 * Default --no-checkpoint policy is enforced upstream in
 * src/lib/rebuild-cli.js. This module is the operator's review surface — if
 * called against a package that has no `.rebuild-staging/` directory, every
 * subcommand fails fast with a clear message.
 *
 * Decision precedence on `approve`:
 *   --all                                  → every pending transform approved
 *   --transform <id>...                    → listed approved, others rejected
 *   checkpoint-state.json (no flags)       → file decisions used
 *   mixed (file + flags)                   → flags override the file per-id
 *
 * Decision values match chunk 08's `promote()` contract: `'approve'` /
 * `'reject'` (not the past-tense forms).
 *
 * `--force` on `reject` skips the interactive y/N prompt. We default to off
 * because a reject is destructive (discards the staging area entirely).
 */

'use strict';

const fs = require('fs').promises;
const fssync = require('fs');
const path = require('path');
const readline = require('readline');
const kleur = require('kleur');

// ============================================================
// SHARED HELPERS
// ============================================================

/**
 * Load brand config from disk, falling back to the default config/brand.json.
 * Returns null on failure (the renderers handle null).
 *
 * Mirrored from rebuild-cli.js — keeping it local avoids cross-module
 * coupling if rebuild-cli's helper signature ever drifts.
 *
 * @param {string|undefined} configPath
 * @returns {Promise<object|null>}
 */
async function loadBrandConfig(configPath) {
  const target = configPath || path.resolve('./config/brand.json');
  try {
    const raw = await fs.readFile(target, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/**
 * Resolve the staging directory paths for a package. The staging directory
 * name is hard-coded here to keep this helper pure; chunk 08's
 * `checkpoint.STAGING_DIR_NAME` is the canonical reference if it ever
 * changes (this module reads it via `deps.checkpoint`).
 *
 * @param {string} engagementsRoot
 * @param {string} engagementId
 * @param {string} packageName  - basename, e.g. "compliance-101.zip" or "compliance-101"
 * @returns {{ engagementDir: string, packageDir: string, stagingDir: string }}
 */
function resolveStagingPaths(engagementsRoot, engagementId, packageName) {
  const engagementDir = path.resolve(engagementsRoot, engagementId);
  // Package dir uses the basename without a trailing .zip — this matches
  // rebuild-cli.js's path calculation when it lays down packageDir.
  const packageBase = packageName.toLowerCase().endsWith('.zip')
    ? packageName.slice(0, -4)
    : packageName;
  const packageDir = path.join(engagementDir, packageBase);
  const stagingDir = path.join(packageDir, '.rebuild-staging');
  return { engagementDir, packageDir, stagingDir };
}

/**
 * Read the staged manifest. Returns null if the file is missing or malformed.
 *
 * @param {Object} fsp - fs.promises shim (for tests)
 * @param {string} stagingDir
 * @returns {Promise<Object|null>}
 */
async function readStagedManifest(fsp, stagingDir) {
  const manifestPath = path.join(stagingDir, 'rebuild-manifest-staged.json');
  try {
    const raw = await fsp.readFile(manifestPath, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

// ============================================================
// ACTION: rebuild-checkpoint approve
// ============================================================

/**
 * Approve action. Promotes a staged rebuild to the package root.
 *
 * @param {Object} cmdOpts - parsed Commander options
 * @param {Object} [deps]  - injectable dependencies for tests
 * @param {Object}   [deps.checkpoint]            - { promote, discard, listPending, readCheckpointState }
 * @param {Function} [deps.renderRebuildDiff]
 * @param {Function} [deps.renderRebuildSummary]
 * @param {Function} [deps.renderRebuildPreview]
 * @param {Function} [deps.exit]                  - process.exit replacement
 * @param {Object}   [deps.fsp]                   - fs.promises replacement
 * @param {Object}   [deps.fss]                   - fs (sync) replacement; existsSync is the only call
 * @param {string[]} [deps.transformFlags]        - explicit override for argv-scanned --transform ids
 * @returns {Promise<void>}
 */
async function approveAction(cmdOpts, deps) {
  const d = deps || {};
  const doExit = d.exit || ((code) => process.exit(code));
  const fsp = d.fsp || fs;
  const fss = d.fss || fssync;
  const checkpoint = d.checkpoint || lazyCheckpoint();
  const renderDiff =
    d.renderRebuildDiff || lazyRequire('../reporter/rebuild-diff', 'renderRebuildDiff');
  const renderSummary =
    d.renderRebuildSummary ||
    lazyRequire('../reporter/rebuild-summary', 'renderRebuildSummary');
  const renderPreview =
    d.renderRebuildPreview ||
    lazyRequire('../reporter/rebuild-preview', 'renderRebuildPreview');

  // ------------------------------------------------------------
  // 1. Validate flags.
  // ------------------------------------------------------------
  if (!cmdOpts.engagement) {
    console.error(kleur.red('Error: --engagement <id> is required for rebuild-checkpoint approve'));
    return doExit(2);
  }
  if (!cmdOpts.package) {
    console.error(kleur.red('Error: --package <name> is required for rebuild-checkpoint approve'));
    return doExit(2);
  }

  // Tests inject explicit flag arrays via deps.transformFlags so they don't
  // pollute the real argv with --transform when running under vitest.
  const transformFlags = Array.isArray(d.transformFlags)
    ? d.transformFlags.slice()
    : collectTransformIds(cmdOpts);
  const wantAll = !!cmdOpts.all;
  const hasTransformFlag = transformFlags.length > 0;

  const engagementsRoot = cmdOpts.engagementsRoot || './engagements';
  const { engagementDir, packageDir, stagingDir } = resolveStagingPaths(
    engagementsRoot,
    cmdOpts.engagement,
    cmdOpts.package
  );

  // ------------------------------------------------------------
  // 2. Verify staging exists.
  // ------------------------------------------------------------
  if (!fss.existsSync(stagingDir)) {
    console.error(kleur.red(`Error: no staged rebuild found for ${cmdOpts.package}`));
    console.error(kleur.gray(`       expected: ${stagingDir}`));
    return doExit(2);
  }

  // ------------------------------------------------------------
  // 3. Read staged manifest + (optional) checkpoint-state.json.
  // ------------------------------------------------------------
  const stagedManifest = await readStagedManifest(fsp, stagingDir);
  if (!stagedManifest) {
    console.error(kleur.red('Error: rebuild-manifest-staged.json missing or unreadable'));
    return doExit(2);
  }
  const transforms = Array.isArray(stagedManifest.transforms)
    ? stagedManifest.transforms
    : [];
  const pending = transforms.filter((t) => t.status === 'pending-checkpoint');

  // checkpoint.readCheckpointState takes the staging dir (not engagement +
  // package) and validates the file's manifestHash matches the staged
  // manifest. Returns the decisions map directly, or null on miss/stale.
  let savedState = null;
  try {
    savedState = await checkpoint.readCheckpointState(stagingDir);
  } catch (_) {
    savedState = null;
  }

  if (!wantAll && !hasTransformFlag && !savedState) {
    console.error(
      kleur.red(
        'Error: must specify --all, --transform <id>..., or save decisions to checkpoint-state.json'
      )
    );
    return doExit(2);
  }

  // ------------------------------------------------------------
  // 4. Build the per-transform decisions map. Values are 'approve' /
  //    'reject' to match checkpoint.promote()'s contract.
  //    Precedence (low -> high):
  //      a. Default 'reject' for every pending transform.
  //      b. checkpoint-state.json overrides (if present).
  //      c. --all: approve every pending transform.
  //      d. --transform <id>...: approve listed, reject others.
  //    Each later step wins on conflict (per-transform).
  // ------------------------------------------------------------
  const decisions = {};
  for (const t of pending) decisions[t.id] = 'reject';

  if (savedState) {
    for (const [id, decision] of Object.entries(savedState)) {
      if (decision === 'approve' || decision === 'reject') {
        decisions[id] = decision;
      }
    }
  }

  if (wantAll) {
    for (const t of pending) decisions[t.id] = 'approve';
  }
  if (hasTransformFlag) {
    const listed = new Set(transformFlags);
    for (const t of pending) {
      decisions[t.id] = listed.has(t.id) ? 'approve' : 'reject';
    }
  }

  // ------------------------------------------------------------
  // 5. Promote.
  // ------------------------------------------------------------
  let promoteResult;
  try {
    promoteResult = await checkpoint.promote(
      engagementDir,
      cmdOpts.package,
      decisions
    );
  } catch (err) {
    console.error(kleur.red(`Error: promotion failed: ${err.message || String(err)}`));
    return doExit(2);
  }

  // ------------------------------------------------------------
  // 6. Promote refused (verification regression, etc.). Per chunk 08,
  //    `promoted: false` is returned with a `reason` and the staging
  //    directory is preserved.
  // ------------------------------------------------------------
  if (promoteResult && promoteResult.promoted === false) {
    console.error(
      kleur.red(`Error: promotion refused — ${promoteResult.reason || 'unknown reason'}`)
    );
    console.error(kleur.gray(`       staging directory preserved at ${stagingDir}`));
    return doExit(2);
  }

  // ------------------------------------------------------------
  // 7. Re-render artifacts at the package root. (diff + summary on the
  //    promoted manifest; preview in archive mode.)
  //    Read the promoted manifest from disk — chunk 08's promote() writes
  //    it but does not return the post-update manifest object.
  // ------------------------------------------------------------
  const finalManifestPath = path.join(packageDir, 'rebuild-manifest.json');
  let finalManifest;
  try {
    finalManifest = JSON.parse(await fsp.readFile(finalManifestPath, 'utf8'));
  } catch (err) {
    console.error(
      kleur.red(`Error: post-promotion manifest unreadable at ${finalManifestPath}: ${err.message || String(err)}`)
    );
    return doExit(2);
  }

  const brandConfig = await loadBrandConfig(cmdOpts.brandConfig);
  const diffPath = path.join(packageDir, 'rebuild-diff.html');
  const summaryPath = path.join(packageDir, 'rebuild-summary.html');
  const previewPath = path.join(packageDir, 'rebuild-preview.html');
  const finalZipPath = path.join(packageDir, 'rebuilt.zip');

  try {
    await renderDiff(finalManifest, brandConfig, diffPath);
    await renderSummary(finalManifest, brandConfig, summaryPath);
    // Preview in archive mode — every transform should now be applied or
    // rejected, no pending. Pass an opts object the renderer can grow into
    // without us having to revisit this call site.
    await renderPreview(finalManifest, brandConfig, previewPath, { mode: 'archive' });
  } catch (err) {
    console.error(kleur.red(`Error: post-promotion rendering failed: ${err.message || String(err)}`));
    return doExit(2);
  }

  // ------------------------------------------------------------
  // 8. Print summary + exit.
  // ------------------------------------------------------------
  const approvedCount = Array.isArray(promoteResult.approvedTransforms)
    ? promoteResult.approvedTransforms.length
    : Object.values(decisions).filter((v) => v === 'approve').length;
  const rejectedCount = Array.isArray(promoteResult.rejectedTransforms)
    ? promoteResult.rejectedTransforms.length
    : Object.values(decisions).filter((v) => v === 'reject').length;
  const verification = finalManifest.verification || {};
  const remaining = typeof verification.remaining === 'number' ? verification.remaining : null;
  const resolved = typeof verification.resolved === 'number' ? verification.resolved : null;
  const introduced = typeof verification.introduced === 'number' ? verification.introduced : null;

  console.log(kleur.green(`✔ Promoted ${cmdOpts.package}`));
  console.log(`  Approved: ${approvedCount}  Rejected: ${rejectedCount}`);
  if (remaining !== null) {
    console.log(`  Verification: resolved ${resolved} | remaining ${remaining} | introduced ${introduced}`);
  }
  console.log(`  rebuilt.zip:           ${finalZipPath}`);
  console.log(`  rebuild-manifest.json: ${finalManifestPath}`);
  console.log(`  rebuild-diff.html:     ${diffPath}`);
  console.log(`  rebuild-summary.html:  ${summaryPath}`);
  console.log(`  rebuild-preview.html:  ${previewPath}`);

  return doExit(remaining === 0 ? 0 : 1);
}

// ============================================================
// ACTION: rebuild-checkpoint reject
// ============================================================

/**
 * Reject action. Discards the entire staging area.
 *
 * @param {Object} cmdOpts
 * @param {Object} [deps]
 * @param {Object}   [deps.checkpoint]
 * @param {Function} [deps.exit]
 * @param {Object}   [deps.fss]      - fs (sync) replacement
 * @param {Function} [deps.confirm]  - async () => boolean; bypasses readline in tests
 * @returns {Promise<void>}
 */
async function rejectAction(cmdOpts, deps) {
  const d = deps || {};
  const doExit = d.exit || ((code) => process.exit(code));
  const fss = d.fss || fssync;
  const checkpoint = d.checkpoint || lazyCheckpoint();
  const confirm = d.confirm || promptYesNo;

  if (!cmdOpts.engagement) {
    console.error(kleur.red('Error: --engagement <id> is required for rebuild-checkpoint reject'));
    return doExit(2);
  }
  if (!cmdOpts.package) {
    console.error(kleur.red('Error: --package <name> is required for rebuild-checkpoint reject'));
    return doExit(2);
  }

  const engagementsRoot = cmdOpts.engagementsRoot || './engagements';
  const { engagementDir, stagingDir } = resolveStagingPaths(
    engagementsRoot,
    cmdOpts.engagement,
    cmdOpts.package
  );

  if (!fss.existsSync(stagingDir)) {
    console.error(kleur.red(`Error: no staged rebuild found for ${cmdOpts.package}`));
    console.error(kleur.gray(`       expected: ${stagingDir}`));
    return doExit(2);
  }

  if (!cmdOpts.force) {
    const proceed = await confirm(
      `This discards every pending transform for ${cmdOpts.package} without writing them to rebuilt.zip. Continue? (y/N) `
    );
    if (!proceed) {
      console.log(kleur.gray('Aborted. Staging area preserved.'));
      return doExit(0);
    }
  }

  try {
    await checkpoint.discard(engagementDir, cmdOpts.package);
  } catch (err) {
    console.error(kleur.red(`Error: discard failed: ${err.message || String(err)}`));
    return doExit(2);
  }

  console.log(kleur.green(`✔ Discarded staging area for ${cmdOpts.package}`));
  return doExit(0);
}

// ============================================================
// ACTION: rebuild-checkpoint list
// ============================================================

/**
 * List action. Walks `engagements/<id>/` for any package with a
 * `.rebuild-staging/` directory and prints the count of pending transforms.
 *
 * @param {Object} cmdOpts
 * @param {Object} [deps]
 * @param {Object}   [deps.checkpoint]
 * @param {Function} [deps.exit]
 * @returns {Promise<void>}
 */
async function listAction(cmdOpts, deps) {
  const d = deps || {};
  const doExit = d.exit || ((code) => process.exit(code));
  const checkpoint = d.checkpoint || lazyCheckpoint();

  if (!cmdOpts.engagement) {
    console.error(kleur.red('Error: --engagement <id> is required for rebuild-checkpoint list'));
    return doExit(2);
  }

  const engagementsRoot = cmdOpts.engagementsRoot || './engagements';
  const engagementDir = path.resolve(engagementsRoot, cmdOpts.engagement);

  let entries;
  try {
    entries = await checkpoint.listPending(engagementDir);
  } catch (err) {
    console.error(kleur.red(`Error: ${err.message || String(err)}`));
    return doExit(2);
  }

  if (!Array.isArray(entries) || entries.length === 0) {
    console.log(kleur.gray(`No packages with pending checkpoints under ${engagementDir}`));
    return doExit(0);
  }

  console.log(kleur.bold(`Pending checkpoints under ${engagementDir}:`));
  for (const e of entries) {
    const pkg = e.packageName || e.package || '(unnamed)';
    const count = typeof e.pendingCount === 'number' ? e.pendingCount : '?';
    const stagingPath = e.stagingPath || e.stagingDir || '';
    console.log(`  • ${pkg} — ${count} pending — ${stagingPath}`);
  }
  return doExit(0);
}

// ============================================================
// REGISTRATION
// ============================================================

/**
 * Register `prism rebuild-checkpoint` with `approve`, `reject`, and `list`
 * subcommands on the parent program.
 *
 * @param {import('commander').Command} program
 * @param {Object} [deps] - injectable for tests
 */
function registerCheckpoint(program, deps) {
  const parent = program
    .command('rebuild-checkpoint')
    .description(
      'Manage the v5 full-tier checkpoint gate.\n' +
      'Promote a staged rebuild (approve), discard staging (reject), or list pending checkpoints (list).'
    );

  parent
    .command('approve')
    .description(
      'Promote a staged full-tier rebuild to the package root, applying approved transforms\n' +
      'and reverting rejected ones, then re-running verification before writing rebuilt.zip.'
    )
    .requiredOption('--engagement <id>', 'Engagement ID (required)')
    .requiredOption('--package <name>', 'Package name (required), e.g. compliance-101.zip')
    .option(
      '--transform <id>',
      'Transform ID to approve (repeat for multiple). Un-listed pending transforms are rejected. Mutually exclusive intent with --all.'
    )
    .option('--all', 'Approve every pending transform without reading checkpoint-state.json', false)
    .option('--brand-config <path>', 'Path to custom brand config (default: config/brand.json)')
    .option('--engagements-root <path>', 'Root directory for engagements (default: ./engagements)', './engagements')
    .action(async (cmdOpts) => {
      await approveAction(cmdOpts, deps);
    });

  parent
    .command('reject')
    .description('Discard the entire staging area for a package without writing transforms to rebuilt.zip.')
    .requiredOption('--engagement <id>', 'Engagement ID (required)')
    .requiredOption('--package <name>', 'Package name (required), e.g. compliance-101.zip')
    .option('--force', 'Skip the y/N confirmation prompt', false)
    .option('--engagements-root <path>', 'Root directory for engagements (default: ./engagements)', './engagements')
    .action(async (cmdOpts) => {
      await rejectAction(cmdOpts, deps);
    });

  parent
    .command('list')
    .description('List every package under the engagement that has a pending .rebuild-staging/ directory.')
    .requiredOption('--engagement <id>', 'Engagement ID (required)')
    .option('--engagements-root <path>', 'Root directory for engagements (default: ./engagements)', './engagements')
    .action(async (cmdOpts) => {
      await listAction(cmdOpts, deps);
    });
}

// ============================================================
// LOCAL UTILITIES
// ============================================================

/**
 * Gather all `--transform <id>` values. Commander stores only the last
 * `--transform` in `cmdOpts.transform` when the option is non-variadic, so
 * we scan `process.argv` directly (matching rebuild-cli.js's `--patch`
 * collector).
 *
 * @param {Object} cmdOpts
 * @returns {string[]}
 */
function collectTransformIds(cmdOpts) {
  const ids = [];
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--transform' && i + 1 < argv.length) {
      ids.push(argv[i + 1]);
      i += 1;
    }
  }
  if (ids.length === 0 && cmdOpts.transform) {
    return Array.isArray(cmdOpts.transform) ? cmdOpts.transform : [cmdOpts.transform];
  }
  return ids;
}

/**
 * Lazy-require `src/rebuild/checkpoint.js`. Wrapping the require lets
 * production code call into chunk 08's module while tests can inject a stub
 * via `deps.checkpoint`. If chunk 08 hasn't shipped yet, the import fails
 * loudly only on the first call — no module-load-time crash.
 *
 * @returns {Object} - the checkpoint module ({ promote, discard, listPending, readCheckpointState })
 */
function lazyCheckpoint() {
  return require('../rebuild/checkpoint');
}

/**
 * Lazy-require a module member. Mirrors rebuild-cli.js's pattern of
 * resolving the renderers at call time so test stubs win.
 *
 * @param {string} modPath
 * @param {string} member
 * @returns {Function}
 */
function lazyRequire(modPath, member) {
  return (...args) => require(modPath)[member](...args);
}

/**
 * Default y/N prompter using readline. Returns true on `y` or `Y`, false on
 * anything else (including empty input). Tests override this via
 * `deps.confirm`.
 *
 * @param {string} prompt
 * @returns {Promise<boolean>}
 */
function promptYesNo(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      const a = (answer || '').trim().toLowerCase();
      resolve(a === 'y' || a === 'yes');
    });
  });
}

module.exports = {
  registerCheckpoint,
  approveAction,
  rejectAction,
  listAction,
  // Exported for chunk 09 / smoke tests if they need to call the helper directly.
  resolveStagingPaths
};
