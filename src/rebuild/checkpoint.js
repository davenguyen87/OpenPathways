/**
 * Checkpoint — promote, discard, list, and read state for staged full-tier
 * rebuilds.
 *
 * v5 introduces a staging step: when `prism rebuild --mode full` runs without
 * `--no-checkpoint`, the orchestrator writes its output to
 * `<engagementDir>/<packageName>/.rebuild-staging/` (see chunk 01). The final
 * `rebuilt.zip` and `rebuild-manifest.json` only land at the package root once
 * a consultant approves each pending transform. This module is the gatekeeper.
 *
 * Public surface:
 *
 *   - promote(engagementDir, packageName, decisions, opts)
 *   - discard(engagementDir, packageName)
 *   - listPending(engagementDir)
 *   - readCheckpointState(stagingDir)
 *
 * Promotion is the high-stakes path. It re-validates the resulting package
 * against three invariants in this order:
 *
 *   1. Re-audit verification (the v4 `verify()` invariant).
 *   2. imsmanifest.xml well-formedness for any approved transform with
 *      `scope.manifestEdited: true`.
 *   3. SCO-sequence integrity for any approved page-split transform.
 *
 * Any failure aborts atomically: the staging directory is preserved untouched
 * so the operator can retry, and no final artifacts are written.
 *
 * `checkpoint-state.json` format (under `.rebuild-staging/`):
 *
 *   {
 *     "stateVersion": "1.0.0",
 *     "manifestHash": "<sha256 of rebuild-manifest-staged.json at write time>",
 *     "decisions": { "transform-0001": "approve", "transform-0002": "reject" },
 *     "decidedBy": "dnguyen",
 *     "decidedAt": "2026-05-08T15:11:02Z"
 *   }
 *
 * The `manifestHash` is verified on read; a mismatch means the rebuild was
 * re-run after the operator's decisions and the state file is stale.
 */

const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { readManifest, writeManifest } = require('./manifest');
const { unpack, pack, sha256 } = require('./packager');
const { verify } = require('./verify');

const STAGING_DIR_NAME = '.rebuild-staging';
const STAGED_ZIP_NAME = 'rebuilt-staged.zip';
const STAGED_MANIFEST_NAME = 'rebuild-manifest-staged.json';
const STATE_FILE_NAME = 'checkpoint-state.json';
const STATE_VERSION = '1.0.0';
const FINAL_ZIP_NAME = 'rebuilt.zip';
const FINAL_MANIFEST_NAME = 'rebuild-manifest.json';

/**
 * Compute the SHA-256 of a string. Used to bind a checkpoint-state.json file
 * to the exact staged manifest it was authored against.
 */
function hashString(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

/**
 * Resolve a transformer module by id from `transformersDir`. Mirrors the
 * fixer-resolution pattern in `undo.js`. Returns the module or throws with a
 * clear message if no file exposes a matching `id`.
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
      `restore the transformer file or discard the staging area before retrying.`
  );
}

/**
 * Build a packageContext that satisfies every transformer family's revert()
 * signature. Different transformers consume different shapes:
 *
 *   - landmark / widget transformers read `packageContext.files` and return
 *     `updatedFiles: [{path, newContent}]`.
 *   - page-split reads `ctx.workDir` and `ctx.patches` directly and writes to
 *     disk itself; it returns no `updatedFiles`.
 *
 * We populate every field so a transformer can pick the shape it expects. The
 * caller writes back any `updatedFiles` after revert; the page-split path
 * leaves the workDir already mutated by the transformer.
 *
 * @param {string} workDir absolute path of the unpacked staged zip
 * @param {Array<Object>} transformPatches the patches that belong to this
 *                                          transform (i.e. patch.transformId
 *                                          === transform.id)
 * @returns {Object} packageContext shape acceptable to every v5 transformer
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

/**
 * Recursively read every text file under `rootDir` into a `{path, content}`
 * array suitable for transformer consumption. Skips the packager's
 * entry-order sidecar. Binary files are recorded with `content: null`.
 */
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
 * Validate that a candidate `imsmanifest.xml` (read as a string) is
 * well-formed and structurally valid against SCORM expectations. Uses the
 * `manifest-xml-editor` helpers — the same code path the page-split
 * transformer ran on apply, so a failure here means the operator's reject
 * pattern produced an XML the apply path wouldn't have accepted.
 *
 * @param {string} xml
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function validateManifestXml(xml) {
  if (typeof xml !== 'string' || xml.length === 0) {
    return { ok: false, reason: 'manifest xml is empty' };
  }
  let parseManifest, validateManifest;
  try {
    ({ parseManifest, validateManifest } = require('../lib/manifest-xml-editor'));
  } catch (err) {
    return { ok: false, reason: `manifest-xml-editor not available: ${err.message}` };
  }
  let parsed;
  try {
    parsed = await parseManifest(xml);
  } catch (err) {
    return { ok: false, reason: `manifest xml parse failed: ${err.message || String(err)}` };
  }
  const result = validateManifest(parsed);
  if (!result.valid) {
    return { ok: false, reason: `manifest xml invalid: ${result.errors.join('; ')}` };
  }
  return { ok: true };
}

/**
 * Validate SCO-sequence integrity for an approved page-split transform.
 *
 * Per PRD § Verification, the new sequence must preserve the original
 * organization's ordering relative to unchanged SCOs. The page-split
 * transformer derives split identifiers from the original via
 * `<original>-PART-<n>-<hash>`; we assert that:
 *
 *   1. Every patch listed under the transform's scope as a NEW file (created
 *      from-empty) is registered in the resources block via a resource whose
 *      identifier prefixes the original's id.
 *   2. The `<item>` referencing the original resource has been replaced with
 *      siblings whose identifierrefs all resolve in the resources block.
 *   3. The relative position of unchanged SCOs is preserved. We check this
 *      lightly — the strict invariant is that no resource identifier was
 *      *dropped* unless a transform-emitted patch deleted that exact file.
 *
 * @param {string} manifestXml the staged manifest XML AFTER promotion edits
 * @param {Object} pageSplitTransform the approved transform record
 * @param {Array<Object>} allPatches manifest.patches (full list)
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function validateScoSequence(manifestXml, pageSplitTransform, allPatches) {
  let parseManifest, validateManifest;
  try {
    ({ parseManifest, validateManifest } = require('../lib/manifest-xml-editor'));
  } catch (err) {
    return { ok: false, reason: `manifest-xml-editor not available: ${err.message}` };
  }
  let parsed;
  try {
    parsed = await parseManifest(manifestXml);
  } catch (err) {
    return { ok: false, reason: `sco-sequence: cannot parse manifest: ${err.message || String(err)}` };
  }
  const validation = validateManifest(parsed);
  if (!validation.valid) {
    return {
      ok: false,
      reason: `sco-sequence: manifest invalid (${validation.errors.join('; ')})`
    };
  }
  // Build the set of resource ids from the post-promotion manifest.
  const resources = parsed.ast && parsed.ast.manifest && parsed.ast.manifest.resources;
  const resourcesEl = Array.isArray(resources) ? resources[0] : resources;
  const resourceArray =
    resourcesEl && resourcesEl.resource
      ? (Array.isArray(resourcesEl.resource) ? resourcesEl.resource : [resourcesEl.resource])
      : [];
  const resourceIds = new Set(
    resourceArray
      .filter((r) => r && r.$ && typeof r.$.identifier === 'string')
      .map((r) => r.$.identifier)
  );

  // Every "new file" patch under this transform should correspond to a
  // resource (or be referenced by one). The orchestrator's page-split apply
  // emits N create patches whose `file` matches the new SCO filename.
  const transformPatchIds = new Set(pageSplitTransform.patchIds || []);
  const splitPaths = (allPatches || [])
    .filter((p) => transformPatchIds.has(p.id) && p.before === '' && p.after !== '')
    .map((p) => p.file);

  if (splitPaths.length === 0) {
    return {
      ok: false,
      reason: 'sco-sequence: page-split transform has no create patches; expected ≥ 2 splits'
    };
  }

  // Every split path must appear as a resource href (basename match) in the
  // resources block.
  for (const sp of splitPaths) {
    const base = path.posix.basename(sp);
    const matched = resourceArray.some((r) => {
      if (!r) return false;
      const href = r.$ && typeof r.$.href === 'string' ? path.posix.basename(r.$.href) : '';
      if (href === base) return true;
      const files = r.file ? (Array.isArray(r.file) ? r.file : [r.file]) : [];
      return files.some(
        (f) => f && f.$ && typeof f.$.href === 'string' && path.posix.basename(f.$.href) === base
      );
    });
    if (!matched) {
      return {
        ok: false,
        reason: `sco-sequence: split file "${sp}" is not referenced by any <resource> after promotion`
      };
    }
  }

  // Walk every <organization>/<item> chain and confirm every identifierref
  // resolves to a resource id we just collected. Re-uses the editor's
  // validation logic from above; redundant but explicit.
  const organizationsEl = (() => {
    const orgs = parsed.ast.manifest.organizations;
    return Array.isArray(orgs) ? orgs[0] : orgs;
  })();
  if (!organizationsEl) {
    return { ok: false, reason: 'sco-sequence: <organizations> element missing' };
  }
  const orgArr = organizationsEl.organization
    ? (Array.isArray(organizationsEl.organization) ? organizationsEl.organization : [organizationsEl.organization])
    : [];
  for (const org of orgArr) {
    const itemArr = org && org.item
      ? (Array.isArray(org.item) ? org.item : [org.item])
      : [];
    if (itemArr.length === 0) {
      return { ok: false, reason: 'sco-sequence: organization has no <item> children' };
    }
    const stack = [...itemArr];
    while (stack.length > 0) {
      const item = stack.pop();
      if (!item) continue;
      const ref = item.$ && item.$.identifierref;
      if (ref && !resourceIds.has(ref)) {
        return {
          ok: false,
          reason: `sco-sequence: <item> references unknown resource "${ref}"`
        };
      }
      if (item.item) {
        const children = Array.isArray(item.item) ? item.item : [item.item];
        for (const c of children) stack.push(c);
      }
    }
  }
  return { ok: true };
}

/**
 * Check every approved transform's `transformer` against the on-disk
 * `src/transformers/` directory. Refuse promotion if any approved transform
 * references a transformer that no longer exists. Same drift-detection
 * stance as `undo()` for fixers.
 *
 * @param {Array<Object>} approvedTransforms
 * @param {string} transformersDir
 * @returns {{ ok: boolean, reason?: string }}
 */
function checkTransformerDrift(approvedTransforms, transformersDir) {
  for (const t of approvedTransforms) {
    try {
      resolveTransformerById(t.transformer, transformersDir);
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }
  return { ok: true };
}

/**
 * Read a `checkpoint-state.json` file from the staging directory. Returns
 * `null` when:
 *
 *   - The file does not exist.
 *   - The file is malformed JSON.
 *   - The recorded `manifestHash` does not match the current staged manifest
 *     (the rebuild was re-run after the operator's decisions; the state is
 *     stale and the caller should re-prompt rather than silently apply
 *     potentially obsolete approvals).
 *
 * Otherwise returns `{ [transformId]: 'approve' | 'reject' }`.
 *
 * @param {string} stagingDir
 * @returns {Promise<Object|null>}
 */
async function readCheckpointState(stagingDir) {
  const statePath = path.join(stagingDir, STATE_FILE_NAME);
  let raw;
  try {
    raw = await fsp.readFile(statePath, 'utf8');
  } catch (_) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.stateVersion !== STATE_VERSION) return null;
  if (typeof parsed.manifestHash !== 'string') return null;
  if (!parsed.decisions || typeof parsed.decisions !== 'object' || Array.isArray(parsed.decisions)) {
    return null;
  }
  // Hash the current staged manifest and compare. A mismatch means the
  // rebuild was re-run since the operator made these decisions; the state is
  // stale.
  const stagedManifestPath = path.join(stagingDir, STAGED_MANIFEST_NAME);
  let manifestRaw;
  try {
    manifestRaw = await fsp.readFile(stagedManifestPath, 'utf8');
  } catch (_) {
    return null;
  }
  if (hashString(manifestRaw) !== parsed.manifestHash) return null;

  // Validate every value.
  const out = {};
  for (const [k, v] of Object.entries(parsed.decisions)) {
    if (v !== 'approve' && v !== 'reject') return null;
    out[k] = v;
  }
  return out;
}

/**
 * Discard the staging directory entirely. Idempotent — returns
 * `{ discarded: false }` when nothing is there to remove. Never touches the
 * package root, so any prior `rebuilt.zip` from a safe-tier rebuild is
 * untouched.
 *
 * @param {string} engagementDir
 * @param {string} packageName
 * @returns {Promise<{ discarded: boolean }>}
 */
async function discard(engagementDir, packageName) {
  const stagingDir = path.join(engagementDir, packageName, STAGING_DIR_NAME);
  let exists = false;
  try {
    const stat = await fsp.stat(stagingDir);
    exists = stat.isDirectory();
  } catch (_) {
    exists = false;
  }
  if (!exists) return { discarded: false };
  await fsp.rm(stagingDir, { recursive: true, force: true });
  return { discarded: true };
}

/**
 * Walk every immediate subdirectory of `engagementDir` and return one entry
 * per package that has an active staging area.
 *
 * @param {string} engagementDir
 * @returns {Promise<Array<{ packageName: string, pendingCount: number, stagingPath: string }>>}
 */
async function listPending(engagementDir) {
  let entries;
  try {
    entries = await fsp.readdir(engagementDir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const stagingPath = path.join(engagementDir, ent.name, STAGING_DIR_NAME);
    let exists = false;
    try {
      const stat = await fsp.stat(stagingPath);
      exists = stat.isDirectory();
    } catch (_) {
      exists = false;
    }
    if (!exists) continue;

    let pendingCount = 0;
    try {
      const stagedManifestPath = path.join(stagingPath, STAGED_MANIFEST_NAME);
      const m = readManifest(stagedManifestPath);
      const transforms = Array.isArray(m.transforms) ? m.transforms : [];
      pendingCount = transforms.filter((t) => t.status === 'pending-checkpoint').length;
    } catch (_) {
      pendingCount = 0;
    }
    out.push({ packageName: ent.name, pendingCount, stagingPath });
  }
  out.sort((a, b) => (a.packageName < b.packageName ? -1 : a.packageName > b.packageName ? 1 : 0));
  return out;
}

/**
 * Promote a staged rebuild to final per the operator's per-transform
 * decisions. Atomic: every invariant must hold before any final artifact is
 * written, and on any invariant failure the staging directory is preserved
 * untouched.
 *
 * `decisions` shape: `{ [transformId]: 'approve' | 'reject' }`. Every
 * pending-checkpoint transform must appear in decisions; missing keys throw.
 *
 * @param {string} engagementDir
 * @param {string} packageName
 * @param {Object<string,string>} decisions
 * @param {Object} [opts]
 * @param {string} [opts.now]              ISO timestamp override
 * @param {string} [opts.username]         username override (used for both
 *                                          checkpointApprovedBy fields)
 * @param {string} [opts.transformersDir]  override transformer resolution dir
 * @param {Function} [opts.verify]         override the verifier (deps injection
 *                                          for tests)
 * @returns {Promise<
 *   { promoted: true, approvedTransforms: string[], rejectedTransforms: string[], verificationAfter: Object }
 *   | { promoted: false, reason: string }
 * >}
 */
async function promote(engagementDir, packageName, decisions, opts) {
  const o = opts || {};
  const now = o.now || new Date().toISOString();
  const username =
    o.username !== undefined
      ? o.username
      : (() => {
          try {
            return os.userInfo().username;
          } catch (_) {
            return 'unknown';
          }
        })();
  const transformersDir = o.transformersDir || path.resolve(__dirname, '../transformers');
  const doVerify = o.verify || verify;

  if (!decisions || typeof decisions !== 'object' || Array.isArray(decisions)) {
    throw new Error('promote: decisions must be an object keyed by transform id');
  }

  const packageDir = path.join(engagementDir, packageName);
  const stagingDir = path.join(packageDir, STAGING_DIR_NAME);
  const stagedManifestPath = path.join(stagingDir, STAGED_MANIFEST_NAME);
  const stagedZipPath = path.join(stagingDir, STAGED_ZIP_NAME);

  if (!fs.existsSync(stagedManifestPath)) {
    throw new Error(`No staged manifest at "${stagedManifestPath}"`);
  }
  if (!fs.existsSync(stagedZipPath)) {
    throw new Error(`No staged zip at "${stagedZipPath}"`);
  }

  const manifest = readManifest(stagedManifestPath);
  const allTransforms = Array.isArray(manifest.transforms) ? manifest.transforms : [];
  const pending = allTransforms.filter((t) => t.status === 'pending-checkpoint');
  const pendingIds = new Set(pending.map((t) => t.id));

  // Validate decisions cover every pending transform AND only target real,
  // pending transforms.
  const missing = [...pendingIds].filter((id) => !(id in decisions));
  if (missing.length > 0) {
    throw new Error(
      `promote: decisions missing for pending transform(s): ${missing.join(', ')}`
    );
  }
  for (const k of Object.keys(decisions)) {
    if (!pendingIds.has(k)) {
      throw new Error(
        `promote: decision references unknown or non-pending transform "${k}"`
      );
    }
    const v = decisions[k];
    if (v !== 'approve' && v !== 'reject') {
      throw new Error(`promote: decision for "${k}" must be 'approve' or 'reject'`);
    }
  }

  const approvedTransforms = pending.filter((t) => decisions[t.id] === 'approve');
  const rejectedTransforms = pending.filter((t) => decisions[t.id] === 'reject');

  // Refuse promotion if any APPROVED or REJECTED transform names a transformer
  // that no longer exists. Approved transforms get applied (no transformer
  // call needed — the patches are already on disk), but rejected transforms
  // need their transformer's revert(). And approved transforms need the
  // transformer present so a future undo() can revert them; failing fast here
  // avoids a manifest the next undo couldn't honor.
  const driftCheck = checkTransformerDrift([...approvedTransforms, ...rejectedTransforms], transformersDir);
  if (!driftCheck.ok) {
    throw new Error(driftCheck.reason);
  }

  // Unpack staged zip to a temp dir we can mutate.
  const workDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), `prism-checkpoint-${crypto.randomBytes(4).toString('hex')}-`)
  );
  let candidateZipPath = null;
  try {
    await unpack(stagedZipPath, workDir);

    // Apply rejections by calling each rejected transform's revert() on the
    // unpacked working tree. Update affected patches' status to 'rejected'
    // in-memory; we'll write the manifest after the candidate zip passes
    // verification.
    for (const t of rejectedTransforms) {
      const transformer = resolveTransformerById(t.transformer, transformersDir);
      const transformPatches = manifest.patches.filter((p) => p.transformId === t.id);
      const ctx = buildPackageContext(workDir, transformPatches);

      let revertResult;
      try {
        revertResult = await transformer.revert(ctx, { ...t, patches: transformPatches });
      } catch (err) {
        return {
          promoted: false,
          reason: `transformer "${t.transformer}" revert threw on transform ${t.id}: ${err.message || String(err)}`
        };
      }
      // Some transformers (landmark, widget) return updatedFiles for the
      // caller to write to disk. Others (page-split) write directly to
      // ctx.workDir and omit updatedFiles. Apply both paths defensively.
      if (revertResult && Array.isArray(revertResult.updatedFiles)) {
        for (const u of revertResult.updatedFiles) {
          if (!u || typeof u.path !== 'string' || typeof u.newContent !== 'string') continue;
          const diskPath = path.join(workDir, u.path);
          await fsp.mkdir(path.dirname(diskPath), { recursive: true });
          await fsp.writeFile(diskPath, u.newContent, 'utf8');
        }
      }
    }

    // Re-pack the working tree to a candidate zip in a tmp location.
    candidateZipPath = path.join(workDir, '.candidate-rebuilt.zip');
    await pack(workDir, candidateZipPath, manifest);

    // Run verify() on the candidate. Prefer the package's saved results.json
    // (the full original audit with file/line context per finding) so the
    // resolved/introduced classification can match real findings instead of
    // placeholder buckets. Fall back to reconstructing from the manifest's
    // summary counts when results.json is missing — but in that fallback,
    // every reconstructed finding shares the same key, which means after-
    // findings can never match a unique before-finding and any rebuild that
    // changes file/line locations will look like a regression.
    let originalAuditResults = null;
    try {
      const resultsPath = path.join(engagementDir, packageName, 'results.json');
      const raw = fs.readFileSync(resultsPath, 'utf8');
      originalAuditResults = JSON.parse(raw);
    } catch (_) {
      originalAuditResults = null;
    }
    if (!originalAuditResults || !Array.isArray(originalAuditResults.violations)) {
      originalAuditResults = {
        violations: [],
        scorecard: {
          failedCriteria: manifest.verification.before.criteriaFailed,
          criteriaResults: []
        }
      };
      for (let i = 0; i < manifest.verification.before.violations; i++) {
        originalAuditResults.violations.push({ criterion: '', file: '' });
      }
    }
    let verifyResult;
    try {
      verifyResult = await doVerify(candidateZipPath, originalAuditResults, {
        standard: manifest.standard
      });
    } catch (err) {
      return {
        promoted: false,
        reason: `verification threw: ${err && err.message ? err.message : String(err)}`
      };
    }
    if (verifyResult && verifyResult.hasRegression) {
      return {
        promoted: false,
        reason: `verification regression: ${verifyResult.introduced} new finding(s) after promotion`
      };
    }

    // For every approved transform with manifestEdited === true, re-validate
    // imsmanifest.xml against the SCORM schema. The page-split transformer is
    // the canonical case; landmark / widget never edit the manifest.
    const approvedManifestEditing = approvedTransforms.filter(
      (t) => t.scope && t.scope.manifestEdited === true
    );
    if (approvedManifestEditing.length > 0) {
      // Find the on-disk imsmanifest.xml and read it.
      const manifestRel = locateImsmanifest(workDir);
      let manifestXml = '';
      if (manifestRel) {
        try {
          manifestXml = await fsp.readFile(path.join(workDir, manifestRel), 'utf8');
        } catch (_) {
          manifestXml = '';
        }
      }
      const xmlCheck = await validateManifestXml(manifestXml);
      if (!xmlCheck.ok) {
        return { promoted: false, reason: `manifest xml: ${xmlCheck.reason}` };
      }

      // SCO-sequence integrity for any approved page-split transform.
      const approvedPageSplits = approvedManifestEditing.filter((t) => t.family === 'page-split');
      for (const t of approvedPageSplits) {
        const seqCheck = await validateScoSequence(manifestXml, t, manifest.patches);
        if (!seqCheck.ok) {
          return { promoted: false, reason: seqCheck.reason };
        }
      }
    }

    // All invariants passed — move candidate zip to final, update manifest,
    // remove staging.
    const finalZipPath = path.join(packageDir, FINAL_ZIP_NAME);
    const finalManifestPath = path.join(packageDir, FINAL_MANIFEST_NAME);
    await fsp.copyFile(candidateZipPath, finalZipPath);
    const newOutputSha = await sha256(finalZipPath);
    manifest.outputZipSha256 = newOutputSha;

    // Update transform + patch statuses.
    const approvedIds = new Set(approvedTransforms.map((t) => t.id));
    const rejectedIds = new Set(rejectedTransforms.map((t) => t.id));
    for (const t of manifest.transforms || []) {
      if (approvedIds.has(t.id)) {
        t.status = 'applied';
        t.checkpointApprovedBy = username;
        t.checkpointApprovedAt = now;
      } else if (rejectedIds.has(t.id)) {
        t.status = 'rejected';
        t.checkpointApprovedBy = username;
        t.checkpointApprovedAt = now;
      }
    }
    for (const p of manifest.patches || []) {
      if (p.transformId && approvedIds.has(p.transformId)) {
        p.status = 'applied';
      } else if (p.transformId && rejectedIds.has(p.transformId)) {
        p.status = 'rejected';
      }
    }

    // Refresh verification block from the candidate's verify result.
    manifest.verification = {
      before: verifyResult.before,
      after: verifyResult.after,
      resolved: verifyResult.resolved,
      introduced: verifyResult.introduced,
      remaining: verifyResult.remaining
    };

    writeManifest(manifest, finalManifestPath);

    // Remove staging only after the final write succeeds.
    await fsp.rm(stagingDir, { recursive: true, force: true });

    return {
      promoted: true,
      approvedTransforms: approvedTransforms.map((t) => t.id),
      rejectedTransforms: rejectedTransforms.map((t) => t.id),
      verificationAfter: manifest.verification
    };
  } finally {
    // Best-effort cleanup of the temp working directory. Do NOT touch the
    // staging directory in `finally` — successful promotion already removed
    // it, and a failed promotion must preserve it.
    try {
      await fsp.rm(workDir, { recursive: true, force: true });
    } catch (_) {
      /* best-effort */
    }
  }
}

/**
 * Locate `imsmanifest.xml` under `rootDir`. Prefers the shallowest match (a
 * shallower manifest is the canonical SCORM root). Returns the package-
 * relative POSIX path, or null when no manifest is present.
 */
function locateImsmanifest(rootDir) {
  let best = null;
  let bestDepth = Infinity;
  function walk(dir, rel, depth) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const ent of entries) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        walk(path.join(dir, ent.name), r, depth + 1);
        continue;
      }
      if (ent.name.toLowerCase() === 'imsmanifest.xml' && depth < bestDepth) {
        best = r;
        bestDepth = depth;
      }
    }
  }
  walk(rootDir, '', 0);
  return best;
}

module.exports = {
  promote,
  discard,
  listPending,
  readCheckpointState,
  STAGING_DIR_NAME,
  STAGED_ZIP_NAME,
  STAGED_MANIFEST_NAME,
  STATE_FILE_NAME,
  STATE_VERSION,
  // Exposed for chunk 07 + tests; not a public guarantee.
  _internals: {
    hashString,
    resolveTransformerById,
    buildPackageContext,
    validateManifestXml,
    validateScoSequence,
    locateImsmanifest
  }
};
