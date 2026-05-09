/**
 * Undo — reverse selected patches and / or transforms from a prior rebuild
 * without re-running the full orchestrator.
 *
 * v4 path: every patch carries `before` / `after` text (with surrounding
 * context) that `revertPatch` in `src/rebuild/types.js` uses to locate and
 * invert the edit. After reverting, undo re-packs the working directory,
 * re-runs verification, and re-renders the diff + summary HTML.
 *
 * v5 path: transforms revert atomically via the owning transformer's
 * `revert(packageContext, transform)` method. Every patch in the transform
 * flips to `status: 'reverted'` together; a partial revert is impossible.
 *
 * `revertHistory` entries gained an optional `revertedTransforms: [...]`
 * field in v5. The serializer in `manifest.js` is owned by chunk 00 and we
 * cannot extend it from here, so we splice the new field into the on-disk
 * JSON after `writeManifest` completes. See `persistRevertHistoryWithTransforms`.
 *
 * Parameter shape (`ids` argument):
 *
 *   - `['patch-0001', 'patch-0002']` (legacy v4 positional array — preserved)
 *   - `{ patches: ['patch-0001'] }`
 *   - `{ transforms: ['transform-0001'] }`
 *   - `{ patches: [...], transforms: [...] }`
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
 * Resolve a transformer module by id from `transformersDir`.
 * Mirrors `resolveFixerById`'s drift-detection stance.
 *
 * @param {string} transformerId
 * @param {string} transformersDir
 * @returns {Object} transformer module
 */
function resolveTransformerById(transformerId, transformersDir) {
  let entries;
  try {
    entries = fs.readdirSync(transformersDir);
  } catch (err) {
    throw new Error(
      `Cannot read transformers directory "${transformersDir}": ${err.message}`
    );
  }
  for (const entry of entries) {
    if (!entry.endsWith('.js')) continue;
    const full = path.join(transformersDir, entry);
    let mod;
    try {
      delete require.cache[require.resolve(full)];
      mod = require(full);
    } catch (_) {
      continue;
    }
    if (mod && mod.id === transformerId) return mod;
  }
  throw new Error(
    `Transformer "${transformerId}" not found in "${transformersDir}". ` +
      `The manifest references a transformer that no longer exists — ` +
      `restore the transformer file or remove the affected transform before running undo.`
  );
}

/**
 * Normalize the `ids` argument into `{ patches: string[], transforms: string[] }`.
 *
 * Accepts:
 *   - legacy array of patch ids (v4 callers)
 *   - { patches: [...] }
 *   - { transforms: [...] }
 *   - { patches: [...], transforms: [...] }
 *
 * @param {Array<string>|Object} ids
 * @returns {{ patches: string[], transforms: string[] }}
 */
function normalizeIds(ids) {
  if (Array.isArray(ids)) {
    return { patches: ids.slice(), transforms: [] };
  }
  if (!ids || typeof ids !== 'object') {
    throw new Error('undo: ids must be an array of patch ids or an object with patches/transforms keys');
  }
  const patches = Array.isArray(ids.patches) ? ids.patches.slice() : [];
  const transforms = Array.isArray(ids.transforms) ? ids.transforms.slice() : [];
  if (patches.length === 0 && transforms.length === 0) {
    throw new Error('undo: at least one patch id or transform id is required');
  }
  return { patches, transforms };
}

/**
 * Build a packageContext shape that satisfies every v5 transformer family's
 * revert() signature. landmark / widget read `packageContext.files`; page-
 * split reads `ctx.workDir` and `ctx.patches` and writes to disk directly.
 * Populating every field lets each transformer pick the shape it expects.
 *
 * @param {string} workDir
 * @param {Array<Object>} transformPatches
 * @returns {Object}
 */
function buildPackageContext(workDir, transformPatches) {
  const files = readPackageFiles(workDir);
  return {
    rootDir: workDir,
    workDir,
    files,
    patches: Array.isArray(transformPatches) ? transformPatches.slice() : []
  };
}

function readPackageFiles(rootDir) {
  const out = [];
  function walk(dir, rel) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        walk(full, r);
        continue;
      }
      if (!ent.isFile()) continue;
      if (r === '.prism-entry-order.json') continue;
      let content = null;
      try {
        content = fs.readFileSync(full, 'utf8');
      } catch (_) {
        content = null;
      }
      out.push({ path: r, content });
    }
  }
  walk(rootDir, '');
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/**
 * After writeManifest, splice `revertedTransforms` into the persisted
 * revertHistory entries. The chunk-00 serializer drops unknown keys; we
 * read the file back, augment, and rewrite without touching the rest of the
 * field order.
 *
 * @param {string} manifestPath
 * @param {Array<{revertedAt:string, revertedBy:string, patchIds:string[], revertedTransforms?:string[]}>} entries
 */
function persistRevertHistoryWithTransforms(manifestPath, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return;
  let raw;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch (_) {
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return;
  }
  if (!Array.isArray(parsed.revertHistory)) return;
  for (let i = 0; i < parsed.revertHistory.length && i < entries.length; i++) {
    const src = entries[i];
    if (Array.isArray(src.revertedTransforms) && src.revertedTransforms.length > 0) {
      parsed.revertHistory[i].revertedTransforms = src.revertedTransforms.slice();
    }
  }
  fs.writeFileSync(manifestPath, JSON.stringify(parsed, null, 2), 'utf8');
}

/**
 * Reverse selected patches and / or transforms in a previously-rebuilt
 * package.
 *
 * @param {string} engagementDir - absolute path, e.g. `engagements/acme-2026`
 * @param {string} packageName   - e.g. `compliance-101.zip`
 * @param {string[]|Object} ids  - patch IDs (legacy array) OR
 *                                  { patches?, transforms? } (v5)
 * @param {Object} [opts]
 * @param {string} [opts.now]              ISO timestamp override (for tests)
 * @param {string} [opts.username]         username override (for tests)
 * @param {string} [opts.fixersDir]        override path to fixers directory
 * @param {string} [opts.transformersDir]  override path to transformers directory
 * @param {string} [opts.engagementsRoot]  override root to derive packageDir from
 *                                         (default: same as engagementDir)
 * @returns {Promise<{ manifest: Object, rebuiltZipPath: string, reverted: string[], revertedTransforms: string[] }>}
 */
async function undo(engagementDir, packageName, ids, opts) {
  const o = opts || {};
  const now = o.now || new Date().toISOString();
  const username =
    o.username !== undefined ? o.username : (() => {
      try { return os.userInfo().username; } catch (_) { return 'unknown'; }
    })();
  const fixersDir =
    o.fixersDir || path.resolve(__dirname, '../fixers');
  const transformersDir =
    o.transformersDir || path.resolve(__dirname, '../transformers');

  const normalized = normalizeIds(ids);

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

  const allTransforms = Array.isArray(manifest.transforms) ? manifest.transforms : [];
  const transformsById = new Map();
  for (const t of allTransforms) transformsById.set(t.id, t);

  // ── 2. Validate requested transforms ──────────────────────────────────
  for (const tid of normalized.transforms) {
    const t = transformsById.get(tid);
    if (!t) {
      throw new Error(
        `Transform "${tid}" not found in manifest at "${manifestPath}".`
      );
    }
    if (t.status !== 'applied') {
      throw new Error(
        `Cannot undo: transform "${tid}" is not in "applied" status (status: ${t.status}).`
      );
    }
  }

  // Set of transform ids being reverted as a whole (used to validate that
  // any individual patches selected don't belong to a transform we're not
  // also reverting).
  const transformsBeingReverted = new Set(normalized.transforms);

  // ── 3. Validate requested individual patch IDs ────────────────────────
  // Refuse mixed-state errors: a patch that belongs to a transform must be
  // reverted via --transform, not --patch (unless the transform is already
  // in the transforms list — in which case we collapse the patch into the
  // transform's revert pass below).
  const standalonePatchIds = []; // patches NOT covered by a listed transform
  const notApplied = [];
  for (const id of normalized.patches) {
    const patch = manifest.patches.find((p) => p.id === id);
    if (!patch) {
      throw new Error(
        `Patch "${id}" not found in manifest at "${manifestPath}".`
      );
    }
    if (patch.transformId) {
      if (!transformsBeingReverted.has(patch.transformId)) {
        throw new Error(
          `patch ${id} belongs to transform ${patch.transformId}; ` +
            `pass --transform ${patch.transformId} instead of --patch ${id}, ` +
            `or include all of the transform's other patches`
        );
      }
      // Patch is covered by an explicitly-listed transform — silently absorbed
      // into that transform's atomic revert. No separate handling needed.
      continue;
    }
    if (patch.status !== 'applied') {
      notApplied.push(`${id} (status: ${patch.status})`);
    }
    standalonePatchIds.push(id);
  }
  if (notApplied.length > 0) {
    throw new Error(
      `Cannot undo: the following patches are not in "applied" status — ` +
        notApplied.join(', ')
    );
  }

  // ── 4. Resolve fixer + transformer modules up front ───────────────────
  // Fixers for standalone (non-transform) patches.
  const uniqueFixerIds = [...new Set(
    standalonePatchIds.map((id) => manifest.patches.find((p) => p.id === id).fixer)
  )];
  const fixerMap = {};
  for (const fixerId of uniqueFixerIds) {
    fixerMap[fixerId] = resolveFixerById(fixerId, fixersDir);
  }
  // Transformers for every transform in the request. Refuse if any reference
  // a transformer that no longer exists in src/transformers/.
  const transformerMap = {};
  for (const tid of normalized.transforms) {
    const t = transformsById.get(tid);
    transformerMap[tid] = resolveTransformerById(t.transformer, transformersDir);
  }

  // ── 5. Unpack current rebuilt.zip ─────────────────────────────────────
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

    // ── 6. Atomic transform reverts ─────────────────────────────────────
    // Process transforms in reverse application order (highest id first) so
    // chained transforms revert in LIFO order.
    const transformsToRevert = normalized.transforms
      .slice()
      .sort((a, b) => {
        const numA = parseInt(String(a).replace('transform-', ''), 10);
        const numB = parseInt(String(b).replace('transform-', ''), 10);
        return numB - numA; // descending
      });

    const revertedPatchIdsAcrossAll = new Set();
    for (const tid of transformsToRevert) {
      const t = transformsById.get(tid);
      const transformPatches = manifest.patches.filter((p) => p.transformId === tid);
      const ctx = buildPackageContext(workDir, transformPatches);
      const transformer = transformerMap[tid];
      const revertResult = await transformer.revert(ctx, { ...t, patches: transformPatches });
      // Apply any updatedFiles to disk. page-split writes directly to workDir
      // and omits this field; landmark / widget produce it for the caller.
      if (revertResult && Array.isArray(revertResult.updatedFiles)) {
        for (const u of revertResult.updatedFiles) {
          if (!u || typeof u.path !== 'string' || typeof u.newContent !== 'string') continue;
          const diskPath = path.join(workDir, u.path);
          await fsp.mkdir(path.dirname(diskPath), { recursive: true });
          await fsp.writeFile(diskPath, u.newContent, 'utf8');
        }
      }
      for (const p of transformPatches) revertedPatchIdsAcrossAll.add(p.id);
    }

    // ── 7. Standalone patch reverts (the v4 path) ───────────────────────
    // Group standalone patchIds by file.
    const patchById = {};
    for (const p of manifest.patches) patchById[p.id] = p;
    const byFile = new Map();
    for (const id of standalonePatchIds) {
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

    // ── 8. Re-pack and update manifest.outputZipSha256 ──────────────────
    await pack(workDir, rebuiltZipPath, manifest);
    const newOutputSha = await sha256(rebuiltZipPath);
    manifest.outputZipSha256 = newOutputSha;

    // ── 9. Mark patches as reverted + flip transform statuses ───────────
    for (const id of standalonePatchIds) {
      const patch = manifest.patches.find((p) => p.id === id);
      if (patch) patch.status = 'reverted';
    }
    for (const id of revertedPatchIdsAcrossAll) {
      const patch = manifest.patches.find((p) => p.id === id);
      if (patch) patch.status = 'reverted';
    }
    for (const tid of normalized.transforms) {
      const t = transformsById.get(tid);
      if (t) t.status = 'reverted';
    }

    // ── 10. Append revertHistory entry ──────────────────────────────────
    // patchIds includes every reverted patch (transform-owned + standalone).
    // The new revertedTransforms field lists transform ids; chunk 00's
    // serializer doesn't know about it, so we splice it back in after
    // writeManifest below.
    const allRevertedPatchIds = [
      ...standalonePatchIds,
      ...Array.from(revertedPatchIdsAcrossAll)
    ];
    // Deduplicate while preserving insertion order.
    const seen = new Set();
    const dedupedPatchIds = [];
    for (const id of allRevertedPatchIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      dedupedPatchIds.push(id);
    }
    const newHistoryEntry = {
      revertedAt: now,
      revertedBy: username,
      patchIds: dedupedPatchIds
    };
    if (normalized.transforms.length > 0) {
      newHistoryEntry.revertedTransforms = normalized.transforms.slice();
    }
    manifest.revertHistory = [...priorRevertHistory, newHistoryEntry];

    // ── 11. Re-run verification ──────────────────────────────────────────
    const originalAuditResults = {
      violations: [],
      scorecard: {
        failedCriteria: manifest.verification.before.criteriaFailed,
        criteriaResults: []
      }
    };
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

    // ── 12. Write manifest ───────────────────────────────────────────────
    writeManifest(manifest, manifestPath);
    persistRevertHistoryWithTransforms(manifestPath, manifest.revertHistory);

    // ── 13. Re-render reports ─────────────────────────────────────────────
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

    return {
      manifest,
      rebuiltZipPath,
      reverted: dedupedPatchIds,
      revertedTransforms: normalized.transforms.slice()
    };

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
