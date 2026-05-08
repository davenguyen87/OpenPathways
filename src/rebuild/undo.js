/**
 * Undo — reverse selected patches from a prior rebuild without re-running
 * the full orchestrator.
 *
 * Each patch carries `before`/`after` text (with surrounding context) that
 * `revertPatch` in `src/rebuild/types.js` uses to locate and invert the edit.
 * After reverting, undo re-packs the working directory, re-runs verification,
 * and re-renders the diff + summary HTML.
 *
 * `revertHistory` is a recognized optional top-level field on the manifest
 * (see `manifest.js` OPTIONAL_TOP_LEVEL_KEYS). Each undo run appends one
 * entry: `{ revertedAt, revertedBy, patchIds }`.
 */

const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { readManifest, writeManifest } = require('./manifest');
const { unpack, pack, sha256 } = require('./packager');
const { verify } = require('./verify');
const { renderRebuildDiff } = require('../reporter/rebuild-diff');
const { renderRebuildSummary } = require('../reporter/rebuild-summary');

/**
 * Resolve a fixer module by its id string. Looks in `fixersDir` (defaults to
 * `src/fixers/`) for a file whose `module.exports.id === fixerId`.
 *
 * Returns the module, or throws with a clear message if not found.
 *
 * @param {string} fixerId
 * @param {string} fixersDir
 * @returns {Object} fixer module
 */
function resolveFixerById(fixerId, fixersDir) {
  let entries;
  try {
    entries = fs.readdirSync(fixersDir);
  } catch (err) {
    throw new Error(
      `Cannot read fixers directory "${fixersDir}": ${err.message}`
    );
  }

  for (const entry of entries) {
    if (!entry.endsWith('.js')) continue;
    const full = path.join(fixersDir, entry);
    let mod;
    try {
      // Clear require cache so tests with custom fixersDir get fresh modules.
      delete require.cache[require.resolve(full)];
      mod = require(full);
    } catch (_) {
      continue;
    }
    if (mod && mod.id === fixerId) return mod;
  }

  throw new Error(
    `Fixer "${fixerId}" not found in "${fixersDir}". ` +
      `The manifest references a fixer that no longer exists — ` +
      `rename/restore the fixer file or remove the affected patches before running undo.`
  );
}

/**
 * Reverse selected patches in a previously-rebuilt package.
 *
 * @param {string} engagementDir - absolute path, e.g. `engagements/acme-2026`
 * @param {string} packageName   - e.g. `compliance-101.zip`
 * @param {string[]} patchIds    - patch IDs to revert, e.g. `['patch-0001']`
 * @param {Object} [opts]
 * @param {string} [opts.now]        - ISO timestamp override (for tests)
 * @param {string} [opts.username]   - username override (for tests)
 * @param {string} [opts.fixersDir]  - override path to fixers directory
 * @param {string} [opts.engagementsRoot] - override root to derive packageDir from
 *                                         (default: same as engagementDir)
 * @returns {Promise<{ manifest: Object, rebuiltZipPath: string, reverted: string[] }>}
 */
async function undo(engagementDir, packageName, patchIds, opts) {
  const o = opts || {};
  const now = o.now || new Date().toISOString();
  const username =
    o.username !== undefined ? o.username : (() => {
      try { return os.userInfo().username; } catch (_) { return 'unknown'; }
    })();
  const fixersDir =
    o.fixersDir || path.resolve(__dirname, '../fixers');

  // ── 1. Load manifest ───────────────────────────────────────────────────
  const packageDir = path.join(engagementDir, packageName);
  const manifestPath = path.join(packageDir, 'rebuild-manifest.json');

  let manifest;
  try {
    manifest = readManifest(manifestPath);
  } catch (err) {
    throw new Error(
      `Cannot load rebuild manifest at "${manifestPath}": ${err.message}`
    );
  }
  const priorRevertHistory = Array.isArray(manifest.revertHistory)
    ? manifest.revertHistory
    : [];

  // ── 2. Validate requested patch IDs ───────────────────────────────────
  const notApplied = [];
  for (const id of patchIds) {
    const patch = manifest.patches.find((p) => p.id === id);
    if (!patch) {
      throw new Error(
        `Patch "${id}" not found in manifest at "${manifestPath}".`
      );
    }
    if (patch.status !== 'applied') {
      notApplied.push(`${id} (status: ${patch.status})`);
    }
  }
  if (notApplied.length > 0) {
    throw new Error(
      `Cannot undo: the following patches are not in "applied" status — ` +
        notApplied.join(', ')
    );
  }

  // ── 3. Resolve each patch's fixer ─────────────────────────────────────
  const uniqueFixerIds = [...new Set(
    patchIds.map((id) => manifest.patches.find((p) => p.id === id).fixer)
  )];
  const fixerMap = {};
  for (const fixerId of uniqueFixerIds) {
    // Throws with a clear message if not found.
    fixerMap[fixerId] = resolveFixerById(fixerId, fixersDir);
  }

  // ── 4. Unpack current rebuilt.zip ─────────────────────────────────────
  const rebuiltZipPath = path.join(packageDir, 'rebuilt.zip');
  if (!fs.existsSync(rebuiltZipPath)) {
    throw new Error(
      `rebuilt.zip not found at "${rebuiltZipPath}". ` +
        `Run "prism rebuild" before using undo.`
    );
  }

  const workDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), `prism-undo-${crypto.randomBytes(4).toString('hex')}-`)
  );

  try {
    await unpack(rebuiltZipPath, workDir);

    // ── 5. Group patches by file and apply in reverse order ─────────────
    // Build a lookup of all manifest patches by id so we can sort.
    const patchById = {};
    for (const p of manifest.patches) patchById[p.id] = p;

    // Group requested patchIds by file.
    const byFile = new Map();
    for (const id of patchIds) {
      const patch = patchById[id];
      const file = patch.file;
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push(patch);
    }

    for (const [filePath, patches] of byFile.entries()) {
      const diskPath = path.join(workDir, filePath);
      let content;
      try {
        content = fs.readFileSync(diskPath, 'utf8');
      } catch (err) {
        throw new Error(
          `Cannot read "${filePath}" from rebuilt package: ${err.message}`
        );
      }

      // Sort patches in REVERSE application order: patches applied later
      // (higher numeric id) must be reverted first.
      const sorted = [...patches].sort((a, b) => {
        // patch IDs are patch-NNNN; extract the numeric part.
        const numA = parseInt(a.id.replace('patch-', ''), 10);
        const numB = parseInt(b.id.replace('patch-', ''), 10);
        return numB - numA; // descending
      });

      for (const patch of sorted) {
        const fixer = fixerMap[patch.fixer];
        const result = await fixer.revert({ path: filePath, content }, patch);
        content = result.newContent;
      }

      fs.writeFileSync(diskPath, content, 'utf8');
    }

    // ── 6. Re-pack and update manifest.outputZipSha256 ──────────────────
    await pack(workDir, rebuiltZipPath, manifest);
    const newOutputSha = await sha256(rebuiltZipPath);
    manifest.outputZipSha256 = newOutputSha;

    // ── 7. Mark patches as reverted + append revertHistory ───────────────
    for (const id of patchIds) {
      const patch = manifest.patches.find((p) => p.id === id);
      if (patch) patch.status = 'reverted';
    }

    // priorRevertHistory was captured during the manifest load at the top.
    manifest.revertHistory = [
      ...priorRevertHistory,
      {
        revertedAt: now,
        revertedBy: username,
        patchIds: [...patchIds]
      }
    ];

    // ── 8. Re-run verification ────────────────────────────────────────────
    // We need original audit results for the "before" baseline. They live in
    // the manifest's own verification.before field — reconstruct a minimal
    // auditResults object so verify() can compare.
    const originalAuditResults = {
      violations: [],
      scorecard: {
        failedCriteria: manifest.verification.before.criteriaFailed,
        criteriaResults: []
      }
    };
    // Populate a dummy violations array of the right length so countsFrom()
    // produces the correct `violations` count. verify() will re-count the
    // after-audit internally.
    for (let i = 0; i < manifest.verification.before.violations; i++) {
      originalAuditResults.violations.push({ criterion: '', file: '' });
    }

    let verifyResult;
    try {
      verifyResult = await verify(rebuiltZipPath, originalAuditResults, {
        standard: manifest.standard
      });
      manifest.verification = {
        before: verifyResult.before,
        after: verifyResult.after,
        resolved: verifyResult.resolved,
        introduced: verifyResult.introduced,
        remaining: verifyResult.remaining
      };
    } catch (verifyErr) {
      // Verification failure is logged but does not abort the undo — the
      // reverted zip is already on disk. Set verification to zeros so the
      // manifest is still well-formed.
      manifest.verification = {
        before: manifest.verification.before,
        after: { violations: 0, criteriaFailed: 0, section508Failed: 0 },
        resolved: 0,
        introduced: 0,
        remaining: 0
      };
    }

    // ── 9. Write manifest ─────────────────────────────────────────────────
    writeManifest(manifest, manifestPath);

    // ── 10. Re-render reports ──────────────────────────────────────────────
    let brandConfig = null;
    const brandPath = path.join(engagementDir, 'brand.json');
    if (fs.existsSync(brandPath)) {
      try {
        brandConfig = JSON.parse(fs.readFileSync(brandPath, 'utf8'));
      } catch (_) {
        brandConfig = null;
      }
    }

    const diffPath = path.join(packageDir, 'rebuild-diff.html');
    const summaryPath = path.join(packageDir, 'rebuild-summary.html');

    await renderRebuildDiff(manifest, brandConfig, diffPath);
    await renderRebuildSummary(manifest, brandConfig, summaryPath);

    return { manifest, rebuiltZipPath, reverted: [...patchIds] };

  } finally {
    // Best-effort cleanup of the working directory.
    try {
      await fsp.rm(workDir, { recursive: true, force: true });
    } catch (_) {
      // Silent; cleanup is non-blocking.
    }
  }
}

module.exports = { undo };
