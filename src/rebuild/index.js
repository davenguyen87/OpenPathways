/**
 * Rebuild orchestrator.
 *
 * Consumes audit results + the original `.zip` and produces a remediated
 * `.zip` plus a manifest of every patch.
 *
 * Tier dispatch:
 *   - `mode === 'safe'`     — runs every safe-tier fixer (v4 path).
 *   - `mode === 'assisted'` — deferred-feature stub until v4.1 lands.
 *   - `mode === 'full'`     — runs safe + assisted fixers, then full-tier
 *     transformers, then either stages output under `.rebuild-staging/`
 *     (the default; chunk 08's checkpoint module promotes it) or writes
 *     directly to the package root when `opts.noCheckpoint === true`.
 *
 * Order within full mode: fixers run per-file (the v4 pass) and THEN
 * transformers run per-package (the v5 pass). Transformers consume the
 * post-fix DOM; landmark insertion, for example, may read the labels
 * assisted-tier added.
 *
 * Out of scope here: re-audit verification (chunk 02), undo (08), diff /
 * summary / preview reports (05/06), CLI wiring (07), checkpoint promotion
 * (08).
 *
 * @typedef {import('./types').Patch} Patch
 * @typedef {import('./types').Transform} Transform
 * @typedef {import('./types').RebuildManifest} RebuildManifest
 */

const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cheerio = require('cheerio');

const { createManifest, addPatch, addTransform, addDeferred } = require('./manifest');
const { unpack, pack, sha256 } = require('./packager');
const { loadTransformers } = require('../lib/transformer-registry');
const { buildProviderFromOptions } = require('../lib/llm-provenance');

const DEFAULT_LOGGER = {
  info: (msg) => process.stdout.write(`${msg}\n`),
  warn: (msg) => process.stderr.write(`${msg}\n`)
};

/**
 * Load fixers in `fixersDir` whose `tier` is in the allowed set. Filters
 * defensively: a file without an allowed `tier` or without both `canFix` and
 * `apply` is skipped. Fixers are sorted by `id` ascending so claim-order is
 * deterministic across machines (filesystem readdir order is not).
 *
 * Within a single tier, every fixer competes equally for each violation; the
 * first match wins (this matches the existing safe-tier behavior). Assisted
 * fixers are typically narrower in their `canFix` claim than safe fixers, so
 * mixing tiers in one pool is intentional — the safe-tier `add-alt-decorative`
 * claims decorative images first; the assisted `generate-alt-text` only
 * claims what's left.
 *
 * @param {string} fixersDir
 * @param {Array<'safe'|'assisted'|'full'>} [tiers=['safe']]
 * @returns {Array}
 */
function loadFixers(fixersDir, tiers) {
  const allowed = new Set(Array.isArray(tiers) && tiers.length > 0 ? tiers : ['safe']);
  const entries = fs.readdirSync(fixersDir);
  const fixers = [];
  for (const entry of entries) {
    if (!entry.endsWith('.js')) continue;
    const full = path.join(fixersDir, entry);
    let mod;
    try {
      // Bypass require cache: tests construct fixersDir fresh per case and
      // can otherwise see a stale module from a previous test file.
      delete require.cache[require.resolve(full)];
      mod = require(full);
    } catch (_) {
      continue;
    }
    if (!mod || !allowed.has(mod.tier)) continue;
    if (typeof mod.canFix !== 'function' || typeof mod.apply !== 'function') continue;
    fixers.push(mod);
  }
  fixers.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return fixers;
}

/**
 * Recursively list every file under `root`, returning POSIX-style relative
 * paths. Used to build the `packageContext.siblings` array fixers consult
 * (e.g. `wire-captions-track` looks for a matching `.vtt`).
 *
 * @param {string} root
 * @returns {string[]}
 */
function listSiblings(root) {
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
      if (ent.isDirectory()) walk(full, r);
      else if (ent.isFile()) out.push(r);
    }
  }
  walk(root, '');
  out.sort();
  return out;
}

/**
 * Group violations by their `file` field. Missing/falsy `file` is bucketed
 * under the empty string so we still emit a deferred entry for it.
 */
function groupByFile(violations) {
  const groups = new Map();
  for (const v of violations || []) {
    const key = v.file || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }
  return groups;
}

/**
 * Validity gate. Returns `{ ok, reason }`. We don't try to be a real parser
 * here — just enough to catch the obvious truncation/balance bugs that a
 * mechanical fixer might emit.
 *
 * - .html / .htm: cheerio.load() must not throw
 * - .json:        JSON.parse() must not throw
 * - .css:         {} must balance — a real CSS parser is overkill
 * - everything else: no validation (.js, .xml, plain text, etc.)
 */
function validateContent(filePath, content) {
  const lower = filePath.toLowerCase();
  try {
    if (lower.endsWith('.html') || lower.endsWith('.htm')) {
      cheerio.load(content);
      return { ok: true };
    }
    if (lower.endsWith('.json')) {
      JSON.parse(content);
      return { ok: true };
    }
    if (lower.endsWith('.css')) {
      let opens = 0;
      let closes = 0;
      for (let i = 0; i < content.length; i++) {
        const c = content.charCodeAt(i);
        if (c === 123 /* { */) opens += 1;
        else if (c === 125 /* } */) closes += 1;
      }
      if (opens !== closes) {
        return { ok: false, reason: 'unbalanced CSS braces' };
      }
      return { ok: true };
    }
  } catch (err) {
    return { ok: false, reason: err.message || String(err) };
  }
  return { ok: true };
}

/**
 * Detect package type by inspecting the on-disk extracted package. We use
 * the SCORM 2004 / 1.2 namespace heuristic from the parser layer; AICC and
 * cmi5 are out of scope for v5 transformers but we still report a value
 * so a transformer can decline cleanly via its `supported` list.
 *
 * @param {string} rootDir
 * @param {string} manifestXml
 * @returns {'scorm12'|'scorm2004'|'aicc'|'cmi5'|'unknown'}
 */
function detectPackageType(rootDir, manifestXml) {
  if (typeof manifestXml === 'string' && manifestXml.length > 0) {
    if (/imscp_v1p1|adlcp_v1p3|adlseq_v1p3|2004/i.test(manifestXml)) return 'scorm2004';
    if (/imscp_rootv1p1p2|adlcp_rootv1p2|1\.2/.test(manifestXml)) return 'scorm12';
    return 'scorm12';
  }
  // No manifest XML — try common AICC siblings before giving up.
  try {
    const entries = fs.readdirSync(rootDir);
    if (entries.some((e) => /\.crs$/i.test(e))) return 'aicc';
    if (entries.includes('cmi5.xml')) return 'cmi5';
  } catch (_) {
    // ignore
  }
  return 'unknown';
}

/**
 * Read every file under `rootDir` (recursively) into the package context's
 * `files[]` array. Skips the entry-order sidecar so transformers don't
 * reason about packager bookkeeping. Files that fail to read as utf-8 are
 * still recorded (with `content: null` and a `binary: true` flag) so a
 * transformer can choose to ignore them rather than crash.
 *
 * @param {string} rootDir
 * @returns {{ path: string, content: string|null, mime: string, binary: boolean }[]}
 */
function readAllFiles(rootDir) {
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
      // Skip the packager's entry-order sidecar — it's bookkeeping, not a
      // package file.
      if (r === '.prism-entry-order.json') continue;

      let content = null;
      let binary = false;
      try {
        content = fs.readFileSync(full, 'utf8');
      } catch (_) {
        binary = true;
      }
      const lower = r.toLowerCase();
      let mime = 'application/octet-stream';
      if (lower.endsWith('.html') || lower.endsWith('.htm')) mime = 'text/html';
      else if (lower.endsWith('.xml')) mime = 'application/xml';
      else if (lower.endsWith('.json')) mime = 'application/json';
      else if (lower.endsWith('.css')) mime = 'text/css';
      else if (lower.endsWith('.js')) mime = 'application/javascript';
      else if (lower.endsWith('.txt')) mime = 'text/plain';
      out.push({ path: r, content, mime, binary });
    }
  }
  walk(rootDir, '');
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/**
 * Validate that an in-memory imsmanifest.xml string is well-formed and
 * parses against the SCORM parser's expectations. Returns
 * `{ ok: true }` on success, `{ ok: false, reason }` otherwise.
 *
 * The parser is invoked indirectly: we write the candidate XML to a temp
 * directory and call `parseScormPackage`. That mirrors the audit's own
 * read path so a transformer that produces XML the audit can't load is
 * caught here, not at re-audit time.
 *
 * @param {string} candidateXml
 * @param {'scorm12'|'scorm2004'|'aicc'|'cmi5'|'unknown'} packageType
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function validateManifestXml(candidateXml, packageType) {
  if (typeof candidateXml !== 'string' || candidateXml.length === 0) {
    return { ok: false, reason: 'manifest xml is empty' };
  }
  // Cheap structural pass first — the parser tends to throw cryptic
  // errors on truly malformed input; xml2js gives us a single clean
  // error message.
  let xml2js;
  try {
    xml2js = require('xml2js');
  } catch (_) {
    return { ok: true }; // xml2js absent (shouldn't happen — listed as a dep) — skip
  }
  const parser = new xml2js.Parser({ ignoreAttrs: false });
  try {
    await parser.parseStringPromise(candidateXml);
  } catch (err) {
    return { ok: false, reason: err && err.message ? err.message : String(err) };
  }
  // Targeted SCORM parse via the project's parser, but only when the
  // package is a SCORM variant. AICC / cmi5 / unknown skip this — a
  // page-split transform on a non-SCORM package would already have been
  // declined via `supported`.
  if (packageType === 'scorm12' || packageType === 'scorm2004') {
    let parseScormPackage;
    try {
      ({ parseScormPackage } = require('../parser/scorm'));
    } catch (_) {
      return { ok: true };
    }
    let tmp;
    try {
      tmp = await fsp.mkdtemp(
        path.join(os.tmpdir(), `prism-rebuild-manifest-validate-${crypto.randomBytes(4).toString('hex')}-`)
      );
      await fsp.writeFile(path.join(tmp, 'imsmanifest.xml'), candidateXml, 'utf8');
      await parseScormPackage(tmp, packageType);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err && err.message ? err.message : String(err) };
    } finally {
      if (tmp) {
        try { await fsp.rm(tmp, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
      }
    }
  }
  return { ok: true };
}

/**
 * Run the full-tier transformer pass. Mutates `manifest` in place and
 * writes touched files back to `workDir`. Drops any transform whose output
 * fails per-file or manifest-XML validation, reverting its patches in
 * reverse application order.
 *
 * @param {Object} args
 * @param {RebuildManifest} args.manifest
 * @param {string} args.workDir
 * @param {string} args.packageName
 * @param {Array} args.violations
 * @param {boolean} args.stageOutputs - true when checkpoint mode is on
 * @param {string} args.transformersDir
 * @param {{ info: Function, warn: Function }} args.logger
 * @param {Function} args.now
 */
async function runTransformerPass({
  manifest,
  workDir,
  packageName,
  violations,
  stageOutputs,
  transformersDir,
  logger,
  now,
  // v5.1: per-rebuild LLM provider for transformer judgment, plus the
  // engagement-level options bag that carries judgment thresholds and the
  // --no-llm-judgment opt-out. Both are optional — when absent the
  // transformers behave exactly as in v5.
  provider,
  options
}) {
  const transformers = loadTransformers(transformersDir).filter((t) => t.tier === 'full');
  if (transformers.length === 0) return;

  // Find imsmanifest.xml (SCORM packages always have one at or near the
  // root). The parser handles nested layouts; here we only need a path the
  // transformer can edit and a string to seed packageContext.
  const allFiles = readAllFiles(workDir);
  const manifestEntry = allFiles.find((f) => /(^|\/)imsmanifest\.xml$/i.test(f.path));
  const manifestRelPath = manifestEntry ? manifestEntry.path : 'imsmanifest.xml';
  const manifestAbsPath = path.join(workDir, manifestRelPath);
  let manifestXml = '';
  try {
    manifestXml = fs.readFileSync(manifestAbsPath, 'utf8');
  } catch (_) {
    manifestXml = '';
  }
  const packageType = detectPackageType(workDir, manifestXml);

  const transformerLogs = [];
  // Some transformers read findings under different field names. Provide
  // every alias the v5 transformers consume (findings, audit.findings,
  // audit.violations, auditFindings) so a transformer's apply() doesn't
  // silently see an empty list and skip every page.
  const findingsList = Array.isArray(violations) ? violations : [];
  const packageContext = {
    rootDir: workDir,
    workDir,
    manifestXml,
    manifestPath: manifestAbsPath,
    packageType,
    parserVersion: packageType,
    files: allFiles,
    auditFindings: findingsList,
    findings: findingsList,
    audit: { findings: findingsList, violations: findingsList },
    // v5.1: provider is null unless full mode + --llm-provider set + not
    // --no-llm-judgment. Widget transformers see this and call classifyWidget
    // when truthy; otherwise they fall back to heuristic-only behavior. opts
    // carries the judgment knobs (confidence threshold, token budget).
    provider: (options && options.llmJudgment === false) ? null : (provider || null),
    opts: {
      llmJudgmentConfidenceThreshold: options && options.llmJudgmentConfidenceThreshold,
      llmJudgmentTokenBudget: options && options.llmJudgmentTokenBudget
    },
    log: (msg) => transformerLogs.push(String(msg))
  };

  for (const transformer of transformers) {
    let claims = false;
    try {
      claims = transformer.canTransform(packageContext);
    } catch (_) {
      claims = false;
    }
    if (!claims) continue;

    let result;
    try {
      result = await transformer.apply(packageContext);
    } catch (err) {
      addDeferred(manifest, {
        criterion: (transformer.criteria && transformer.criteria[0]) || '',
        triage: transformer.triage || 'author rework',
        reason: `transformer ${transformer.id} threw: ${err && err.message ? err.message : String(err)}`,
        file: '',
        line: 0
      });
      continue;
    }

    // v5.1: surface any deferred entries the transformer emitted (e.g. LLM
    // judgment rejected a candidate). These must propagate even when the
    // transformer ends up emitting zero patches — that's exactly the case
    // where the consultant most needs to see what the LLM dropped.
    if (result && Array.isArray(result.deferred)) {
      for (const d of result.deferred) {
        try {
          addDeferred(manifest, {
            criterion: d.criterion || (transformer.criteria && transformer.criteria[0]) || '',
            triage: d.triage || transformer.triage || 'author rework',
            reason: d.reason || `${transformer.id} declined`,
            file: d.file || '',
            line: typeof d.line === 'number' ? d.line : 0
          });
        } catch (_) {
          // Malformed deferred entry from a transformer is a transformer
          // bug — skip silently so it doesn't block the rebuild.
        }
      }
    }

    if (!result || !Array.isArray(result.patches) || result.patches.length === 0) {
      // No-op apply — the transformer claimed but emitted nothing. Not a
      // failure; just skip.
      continue;
    }

    const transformShape = result.transform || {};

    // Append every patch first so we can build a stable patchIds list to
    // hand to addTransform. Keep the assigned ids in declaration order.
    const appendedPatches = [];
    const writeQueue = []; // [{ filePath, beforeContent, afterContent }]
    let writeOrderInvalid = false;
    let appendError = null;

    // We track per-file pre-transform content so revert reverses every
    // edit cleanly even when a transformer wrote multiple patches to the
    // same file.
    const preTransformContent = new Map();
    function readPre(filePath) {
      if (preTransformContent.has(filePath)) return preTransformContent.get(filePath);
      try {
        const c = fs.readFileSync(path.join(workDir, filePath), 'utf8');
        preTransformContent.set(filePath, c);
        return c;
      } catch (_) {
        preTransformContent.set(filePath, null);
        return null;
      }
    }

    for (const rawPatch of result.patches) {
      const patch = { ...rawPatch };
      // Transformers often pre-populate transformId with a local placeholder
      // (e.g. "<id>-local") so apply() returns self-consistent objects, but
      // the manifest validator only accepts global "transform-NNNN" ids that
      // addTransform assigns later. Strip the placeholder; addTransform calls
      // linkPatchToTransform on every listed patch after the transform id is
      // known, restoring the link with the correct value.
      delete patch.transformId;
      if (patch.tier === undefined) patch.tier = 'full';
      if (patch.status === undefined) patch.status = 'applied';
      if (patch.reversible === undefined) patch.reversible = true;
      if (!patch.provenance) {
        patch.provenance = {
          source: transformer.provenance === 'llm' ? 'llm' : 'rule-based',
          timestamp: now().toISOString()
        };
      }
      if (patch.fixer === undefined) patch.fixer = transformer.id;

      let appended;
      try {
        appended = addPatch(manifest, patch);
      } catch (err) {
        appendError = err;
        break;
      }
      appendedPatches.push(appended);
      // Pre-read every touched file so we can revert byte-identical on
      // failure, even when multiple patches share a file.
      if (appended.file) readPre(appended.file);
      writeQueue.push({
        filePath: appended.file,
        before: appended.before,
        after: appended.after
      });
    }

    if (appendError) {
      // Roll back any patches we *did* append before the failure. This is
      // an in-memory rollback — nothing has been written to disk yet.
      manifest.patches.length -= appendedPatches.length;
      addDeferred(manifest, {
        criterion: (transformer.criteria && transformer.criteria[0]) || '',
        triage: transformer.triage || 'author rework',
        reason: `transformer ${transformer.id} emitted invalid patch: ${appendError.message || String(appendError)}`,
        file: '',
        line: 0
      });
      continue;
    }

    // Write each patch's `after` content to disk by locating the patch's
    // `before` substring in the current file content and substituting it.
    // Special-case three shapes that v5 full-tier transforms produce:
    //   - before === "": file creation. Write `after` directly. The file
    //     may or may not already exist (a self-writing transformer like
    //     page-split may have created it via ctx.workDir).
    //   - after === "": file deletion. Remove the file if present.
    //   - whole-file replacement (before is the file's prior content):
    //     write `after` directly so we don't depend on substring location
    //     when the content includes itself.
    // Using indexOf-substitution (rather than offset arithmetic) for the
    // common case means a transformer can list patches in any order
    // without an interleaving bug, and it matches how `revertPatch` finds
    // the after-text on undo.
    const touchedFiles = new Set();
    for (const w of writeQueue) {
      if (!w.filePath) {
        writeOrderInvalid = true;
        break;
      }
      const diskPath = path.join(workDir, w.filePath);
      // File deletion patch (after === "" with a non-empty before).
      if (w.after === '' && w.before !== '') {
        try {
          fs.unlinkSync(diskPath);
        } catch (_) {
          // Already gone — likely a self-writing transformer removed it.
        }
        touchedFiles.add(w.filePath);
        continue;
      }
      // File creation patch (before === "").
      if (w.before === '') {
        fs.mkdirSync(path.dirname(diskPath), { recursive: true });
        fs.writeFileSync(diskPath, w.after, 'utf8');
        touchedFiles.add(w.filePath);
        continue;
      }
      let current;
      try {
        current = fs.readFileSync(diskPath, 'utf8');
      } catch (_) {
        // File may have been removed by a self-writing transformer (e.g.
        // page-split deletes the original SCO before this loop runs). If
        // the file is gone but the patch shape is "delete" we already
        // handled above; otherwise the writer has already done its work
        // and there's nothing for us to do.
        touchedFiles.add(w.filePath);
        continue;
      }
      // Already-applied patch: file content matches `after` (a self-
      // writing transformer produced the final content). Skip.
      if (current === w.after) {
        touchedFiles.add(w.filePath);
        continue;
      }
      // Whole-file replacement: `before` IS the entire file content. Avoid
      // the indexOf path so we don't accidentally match a substring.
      if (current === w.before) {
        fs.writeFileSync(diskPath, w.after, 'utf8');
        touchedFiles.add(w.filePath);
        continue;
      }
      const idx = current.indexOf(w.before);
      if (idx === -1) {
        writeOrderInvalid = true;
        break;
      }
      const updated = current.slice(0, idx) + w.after + current.slice(idx + w.before.length);
      fs.writeFileSync(diskPath, updated, 'utf8');
      touchedFiles.add(w.filePath);
    }

    // Validate every touched file. HTML reparses, JSON parses, manifest
    // XML validates against the SCORM schema (when scope.manifestEdited
    // is true). Any failure drops the whole transform. Files that the
    // transform deleted (last write for that path had after === "") are
    // skipped — there's nothing to validate.
    const deletedPaths = new Set();
    for (const w of writeQueue) {
      if (!w.filePath) continue;
      if (w.after === '' && w.before !== '') deletedPaths.add(w.filePath);
      else deletedPaths.delete(w.filePath); // a later write resurrected it
    }
    let dropReason = null;
    if (writeOrderInvalid) {
      dropReason = 'transformer produced invalid output';
    } else {
      for (const filePath of touchedFiles) {
        if (deletedPaths.has(filePath)) continue;
        const diskPath = path.join(workDir, filePath);
        let content;
        try {
          content = fs.readFileSync(diskPath, 'utf8');
        } catch (err) {
          dropReason = `transformer produced invalid output: ${err.message || String(err)}`;
          break;
        }
        const v = validateContent(filePath, content);
        if (!v.ok) {
          dropReason = 'transformer produced invalid output';
          break;
        }
      }
    }

    if (
      !dropReason &&
      transformShape.scope &&
      transformShape.scope.manifestEdited === true
    ) {
      // Re-read the on-disk manifest XML (the transformer may have
      // rewritten it) and validate.
      const xmlForValidation = (() => {
        try {
          return fs.readFileSync(manifestAbsPath, 'utf8');
        } catch (_) {
          return '';
        }
      })();
      const result2 = await validateManifestXml(xmlForValidation, packageType);
      if (!result2.ok) {
        dropReason = 'transformer produced invalid output';
      } else {
        // Refresh the cached manifest XML so subsequent transformers see
        // the post-edit version.
        packageContext.manifestXml = xmlForValidation;
      }
    }

    if (dropReason) {
      // Revert in reverse order using each patch's `before` value. Mirror
      // the create / delete / whole-file special cases used during apply.
      for (let i = writeQueue.length - 1; i >= 0; i--) {
        const w = writeQueue[i];
        if (!w.filePath) continue;
        const diskPath = path.join(workDir, w.filePath);
        // Created file: rollback removes it.
        if (w.before === '') {
          try { fs.unlinkSync(diskPath); } catch (_) {}
          continue;
        }
        // Deleted file: rollback restores content from `before`.
        if (w.after === '' && w.before !== '') {
          try {
            fs.mkdirSync(path.dirname(diskPath), { recursive: true });
            fs.writeFileSync(diskPath, w.before, 'utf8');
          } catch (_) {}
          continue;
        }
        let current;
        try {
          current = fs.readFileSync(diskPath, 'utf8');
        } catch (_) {
          continue;
        }
        // Whole-file replacement.
        if (current === w.after) {
          fs.writeFileSync(diskPath, w.before, 'utf8');
          continue;
        }
        const idx = current.indexOf(w.after);
        if (idx === -1) {
          // After-text isn't on disk — most likely because the write
          // earlier in the loop never landed. Restore the pre-transform
          // bytes if we have them.
          const pre = preTransformContent.get(w.filePath);
          if (typeof pre === 'string') {
            fs.writeFileSync(diskPath, pre, 'utf8');
          }
          continue;
        }
        const reverted = current.slice(0, idx) + w.before + current.slice(idx + w.after.length);
        fs.writeFileSync(diskPath, reverted, 'utf8');
      }
      // Restore any file we have a pre-transform snapshot for, in case
      // partial writes left a file in a hybrid state (defensive — the
      // indexOf path should already have made this unnecessary).
      for (const [filePath, pre] of preTransformContent.entries()) {
        if (typeof pre !== 'string') continue;
        const diskPath = path.join(workDir, filePath);
        try {
          const current = fs.readFileSync(diskPath, 'utf8');
          // Only overwrite if any after-text from this transform's queue
          // is still present (defensive against an odd revert miss).
          const stillDirty = writeQueue.some(
            (w) => w.filePath === filePath && current.includes(w.after) && !current.includes(w.before)
          );
          if (stillDirty) fs.writeFileSync(diskPath, pre, 'utf8');
        } catch (_) {
          // best-effort
        }
      }
      // Drop the transform's patches from the manifest. They were appended
      // contiguously at the end of `manifest.patches`, so trim by length.
      manifest.patches.length -= appendedPatches.length;
      addDeferred(manifest, {
        criterion: (transformer.criteria && transformer.criteria[0]) || '',
        triage: transformer.triage || 'author rework',
        reason: dropReason,
        file: '',
        line: 0
      });
      logger.warn(
        `[rebuild] transformer ${transformer.id} dropped: ${dropReason}`
      );
      continue;
    }

    // Build the final Transform record. The transformer may have populated
    // most fields already; we fill in defaults for the rest.
    const provSource = transformer.provenance === 'llm' ? 'llm' : 'rule-based';
    const status = stageOutputs ? 'pending-checkpoint' : 'applied';
    const transformRecord = {
      transformer: transformShape.transformer || transformer.id,
      family: transformShape.family || transformer.family,
      criteria: Array.isArray(transformShape.criteria)
        ? transformShape.criteria.slice()
        : (transformer.criteria || []).slice(),
      tier: 'full',
      scope: transformShape.scope && typeof transformShape.scope === 'object'
        ? {
            files: Array.isArray(transformShape.scope.files)
              ? transformShape.scope.files.slice()
              : Array.from(touchedFiles),
            manifestEdited:
              transformShape.scope.manifestEdited === true
          }
        : { files: Array.from(touchedFiles), manifestEdited: false },
      patchIds: appendedPatches.map((p) => p.id),
      provenance: transformShape.provenance && typeof transformShape.provenance === 'object'
        ? { ...transformShape.provenance }
        : { source: provSource, timestamp: now().toISOString() },
      rationale: typeof transformShape.rationale === 'string' ? transformShape.rationale : '',
      previewPath: typeof transformShape.previewPath === 'string'
        ? transformShape.previewPath
        : 'rebuild-preview.html',
      requiresCheckpointApproval:
        typeof transformShape.requiresCheckpointApproval === 'boolean'
          ? transformShape.requiresCheckpointApproval
          : true,
      status
    };
    if (transformShape.checkpointApprovedBy !== undefined) {
      transformRecord.checkpointApprovedBy = transformShape.checkpointApprovedBy;
    }
    if (transformShape.checkpointApprovedAt !== undefined) {
      transformRecord.checkpointApprovedAt = transformShape.checkpointApprovedAt;
    }
    // v5.1: forward the optional LLM judgment field if the transformer set
    // one. Without this copy the field is silently dropped here even though
    // the transformer correctly populated it.
    if (transformShape.judgment !== undefined) {
      transformRecord.judgment = transformShape.judgment;
    }

    try {
      addTransform(manifest, transformRecord);
    } catch (err) {
      // The shape already passed addPatch; an addTransform failure is most
      // likely a bad scope or unresolved patch id. Roll back patches and
      // file writes — mirror the create / delete / whole-file special
      // cases applied during write.
      for (let i = writeQueue.length - 1; i >= 0; i--) {
        const w = writeQueue[i];
        if (!w.filePath) continue;
        const diskPath = path.join(workDir, w.filePath);
        if (w.before === '') {
          try { fs.unlinkSync(diskPath); } catch (_) {}
          continue;
        }
        if (w.after === '' && w.before !== '') {
          try {
            fs.mkdirSync(path.dirname(diskPath), { recursive: true });
            fs.writeFileSync(diskPath, w.before, 'utf8');
          } catch (_) {}
          continue;
        }
        let current;
        try {
          current = fs.readFileSync(diskPath, 'utf8');
        } catch (_) {
          continue;
        }
        if (current === w.after) {
          fs.writeFileSync(diskPath, w.before, 'utf8');
          continue;
        }
        const idx = current.indexOf(w.after);
        if (idx === -1) continue;
        const reverted = current.slice(0, idx) + w.before + current.slice(idx + w.after.length);
        fs.writeFileSync(diskPath, reverted, 'utf8');
      }
      manifest.patches.length -= appendedPatches.length;
      addDeferred(manifest, {
        criterion: (transformer.criteria && transformer.criteria[0]) || '',
        triage: transformer.triage || 'author rework',
        reason: `transformer ${transformer.id} produced invalid transform: ${err.message || String(err)}`,
        file: '',
        line: 0
      });
    }

    // Refresh packageContext.files for downstream transformers so they see
    // the post-transform DOM.
    packageContext.files = readAllFiles(workDir);
  }

  // packageName is currently unused below but accepting it keeps the
  // helper's signature stable for chunk 09's integration tests, which
  // assert on a per-package log line.
  void packageName;
}

/**
 * Main entry point. See module docstring for behavior.
 *
 * @param {string} packagePath
 * @param {{ violations?: Array, [k: string]: any }} auditResults
 * @param {object} [opts]
 * @returns {Promise<{ manifest: RebuildManifest, rebuiltZipPath?: string|null, stagedZipPath?: string, stagingDir?: string }>}
 */
async function rebuild(packagePath, auditResults, opts) {
  const o = opts || {};
  const mode = o.mode || 'safe';
  const standard = o.standard || 'wcag22';
  const engagementId = o.engagementId || 'unknown';
  const packageName = o.packageName || path.basename(packagePath);
  const fixersDir = o.fixersDir || path.resolve(__dirname, '../fixers');
  const now = typeof o.now === 'function' ? o.now : () => new Date();
  const logger = o.logger || DEFAULT_LOGGER;
  const violations = (auditResults && Array.isArray(auditResults.violations))
    ? auditResults.violations
    : [];

  // Hash the input zip up-front so even a no-op (assisted/full) manifest is
  // self-describing.
  const inputZipSha256 = await sha256(packagePath);

  // Tier dispatch: safe runs only safe-tier fixers; assisted runs safe +
  // assisted fixers (assisted ones only fire when LLM credentials are
  // supplied — without them their canFix() returns false and the violation
  // defers); full runs safe + assisted fixers and then the transformer pass.
  // The early-exit assisted stub from v4 was removed when v4.1 wired the
  // assisted-tier fixers below.
  const isFull = mode === 'full';
  const isAssistedOrFull = mode === 'assisted' || isFull;
  const fixerTiers = isAssistedOrFull ? ['safe', 'assisted'] : ['safe'];

  // One LLM provider per rebuild() call — engagement isolation. Returns
  // null when --llm-provider isn't set; assisted fixers see that and defer.
  // Tests (and callers that want to share a client) may inject a pre-built
  // provider via `opts.llmProviderInstance`; when supplied it wins over the
  // CLI-flag-driven path so the env-var dance is unnecessary.
  const llmProvider = isAssistedOrFull
    ? (o.llmProviderInstance || buildProviderFromOptions(o))
    : null;
  const stageOutputs = isFull && o.noCheckpoint !== true;

  const manifestOpts = {
    engagementId,
    packageName,
    inputZipSha256,
    mode,
    standard,
    createdAt: now().toISOString()
  };
  // Bump schemaVersion only when the run actually intends to dispatch
  // full-tier transformers. Safe / assisted modes keep "1.0.0" so v4 / v4.1
  // byte-identical manifest output is preserved.
  if (isFull) manifestOpts.schemaVersion = '2.0.0';
  const manifest = createManifest(manifestOpts);

  // Working dir under os.tmpdir(); cleaned up in finally.
  const workDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), `prism-rebuild-${crypto.randomBytes(4).toString('hex')}-`)
  );
  // Output path: `<packageName>.rebuilt.zip`, replacing trailing `.zip` if
  // present (so `foo.zip` -> `foo.rebuilt.zip`, not `foo.zip.rebuilt.zip`).
  // In full + checkpoint-on mode the output is staged under
  // `<outputDir>/.rebuild-staging/rebuilt-staged.zip`; chunk 08 promotes it.
  const outputDir = o.outputDir || (await fsp.mkdtemp(
    path.join(os.tmpdir(), `prism-rebuild-out-${crypto.randomBytes(4).toString('hex')}-`)
  ));
  await fsp.mkdir(outputDir, { recursive: true });
  const baseName = packageName.toLowerCase().endsWith('.zip')
    ? packageName.slice(0, -4)
    : packageName;

  const stagingDir = path.join(outputDir, '.rebuild-staging');
  const stagedZipPath = path.join(stagingDir, 'rebuilt-staged.zip');
  const stagedManifestPath = path.join(stagingDir, 'rebuild-manifest-staged.json');
  const inlineRebuiltZipPath = path.join(outputDir, `${baseName}.rebuilt.zip`);
  const rebuiltZipPath = stageOutputs ? stagedZipPath : inlineRebuiltZipPath;

  try {
    await unpack(packagePath, workDir);

    const fixers = loadFixers(fixersDir, fixerTiers);
    const grouped = groupByFile(violations);
    // Build the per-package sibling list once so fixers like
    // `wire-captions-track` can locate companion files (.vtt etc.).
    const siblings = listSiblings(workDir);
    // packageContext threads through every fixer's apply(). v4.1 added
    // `provider` and `options` so assisted-tier fixers can call the LLM
    // through a per-rebuild provider instance (engagement-isolated).
    const packageContext = {
      siblings,
      provider: llmProvider,
      options: o,
      engagementId,
      packageName
    };

    for (const [filePath, fileViolations] of grouped.entries()) {
      // No file-level path means we cannot localize the fix; defer.
      if (!filePath) {
        for (const v of fileViolations) {
          addDeferred(manifest, {
            criterion: v.criterion || '',
            triage: v.triage || 'auto-fix safe',
            reason: 'violation has no associated file',
            file: '',
            line: typeof v.line === 'number' ? v.line : 0
          });
        }
        continue;
      }

      const diskPath = path.join(workDir, filePath);
      let originalContent;
      try {
        originalContent = fs.readFileSync(diskPath, 'utf8');
      } catch (_) {
        for (const v of fileViolations) {
          addDeferred(manifest, {
            criterion: v.criterion || '',
            triage: v.triage || 'auto-fix safe',
            reason: `file not present in package: ${filePath}`,
            file: filePath,
            line: typeof v.line === 'number' ? v.line : 0
          });
        }
        continue;
      }

      const isHtml = filePath.endsWith('.html') || filePath.endsWith('.htm');
      let content = originalContent;

      // Each violation gets at most one claiming fixer (first match wins).
      // Build the per-fixer claim map up front so we can apply each fixer
      // exactly once even when it claims multiple violations in this file.
      const claims = new Map(); // fixer -> Violation[]
      for (const violation of fileViolations) {
        let claimed = false;
        for (const fixer of fixers) {
          let fits = false;
          try {
            fits = fixer.canFix({ path: filePath, content, isHtml }, violation);
          } catch (_) {
            fits = false;
          }
          if (fits) {
            if (!claims.has(fixer)) claims.set(fixer, []);
            claims.get(fixer).push(violation);
            claimed = true;
            break;
          }
        }
        if (!claimed) {
          addDeferred(manifest, {
            criterion: violation.criterion || '',
            triage: violation.triage || 'auto-fix safe',
            reason: `no fixer registered for criterion ${violation.criterion || '(unknown)'}`,
            file: filePath,
            line: typeof violation.line === 'number' ? violation.line : 0
          });
        }
      }

      // Apply each claiming fixer in id-sorted order. `content` threads
      // through; if a fixer's output fails the validity gate we drop its
      // patches and DO NOT advance `content`.
      for (const fixer of fixers) {
        if (!claims.has(fixer)) continue;
        const claimed = claims.get(fixer);

        let result;
        try {
          result = await fixer.apply(
            { path: filePath, content, isHtml },
            claimed,
            packageContext
          );
        } catch (err) {
          for (const v of claimed) {
            addDeferred(manifest, {
              criterion: v.criterion || '',
              triage: v.triage || 'auto-fix safe',
              reason: `fixer ${fixer.id} threw: ${err.message || String(err)}`,
              file: filePath,
              line: typeof v.line === 'number' ? v.line : 0
            });
          }
          continue;
        }

        // Some fixers (e.g. wire-captions-track) emit per-violation
        // deferred entries when they decline a specific case. Consume
        // those regardless of whether `changed` is true — a fixer can
        // patch some violations and defer others in the same call.
        if (result && Array.isArray(result.deferred)) {
          for (const d of result.deferred) {
            try {
              addDeferred(manifest, {
                criterion: d.criterion || '',
                triage: d.triage || 'auto-fix safe',
                reason: d.reason || `${fixer.id} declined to fix`,
                file: d.file || filePath,
                line: typeof d.line === 'number' ? d.line : 0
              });
            } catch (_) {
              // Malformed deferred entry from the fixer — skip silently.
            }
          }
        }

        if (!result || result.changed !== true) {
          // No-op apply: not a failure, just nothing to do here.
          continue;
        }

        const validity = validateContent(filePath, result.newContent);
        if (!validity.ok) {
          for (const _patch of result.patches || []) {
            addDeferred(manifest, {
              criterion: _patch.criterion || '',
              triage: _patch.triage || 'auto-fix safe',
              reason: 'fixer produced invalid output',
              file: filePath,
              line: _patch.range && typeof _patch.range.startLine === 'number'
                ? _patch.range.startLine
                : 0
            });
          }
          // Discard this fixer's edit; keep `content` at the prior value so
          // subsequent fixers see un-corrupted input.
          continue;
        }

        for (const patch of result.patches || []) {
          try {
            addPatch(manifest, patch);
          } catch (err) {
            // A malformed patch from a fixer is a fixer bug — surface it
            // via deferred rather than crash the whole rebuild.
            addDeferred(manifest, {
              criterion: patch.criterion || '',
              triage: patch.triage || 'auto-fix safe',
              reason: `fixer emitted invalid patch: ${err.message || String(err)}`,
              file: filePath,
              line: patch.range && typeof patch.range.startLine === 'number'
                ? patch.range.startLine
                : 0
            });
          }
        }

        content = result.newContent;
      }

      if (content !== originalContent) {
        fs.writeFileSync(diskPath, content, 'utf8');
      }
    }

    // ---------------------------------------------------------------------
    // v5 full-tier transformer pass. Runs after every fixer has finished;
    // each transformer sees the post-fix DOM. Skipped entirely when mode is
    // not 'full', so safe / assisted output stays byte-identical to v4 /
    // v4.1.
    // ---------------------------------------------------------------------
    if (isFull) {
      await runTransformerPass({
        manifest,
        workDir,
        packageName,
        violations,
        stageOutputs,
        transformersDir: o.transformersDir || path.resolve(__dirname, '../transformers'),
        logger,
        now,
        // v5.1: thread the per-rebuild provider + judgment options into the
        // transformer pass. Same provider instance the fixers got.
        provider: llmProvider,
        options: o
      });
    }

    if (stageOutputs) {
      await fsp.mkdir(stagingDir, { recursive: true });
    }
    await pack(workDir, rebuiltZipPath, manifest);

    const outputZipSha256 = await sha256(rebuiltZipPath);
    manifest.inputZipSha256 = inputZipSha256;
    manifest.outputZipSha256 = outputZipSha256;

    if (stageOutputs) {
      // Staged outputs live alongside the final zip under .rebuild-staging/.
      // Chunk 08's checkpoint module reads / promotes both. The orchestrator
      // does NOT call verify() against the staged zip; verification runs at
      // promotion time (PRD v5 § "Checkpoint lifecycle" step 5).
      const { writeManifest } = require('./manifest');
      writeManifest(manifest, stagedManifestPath);
      return { manifest, stagedZipPath, stagingDir };
    }

    return { manifest, rebuiltZipPath };
  } finally {
    // Best-effort cleanup of the working dir. The rebuilt zip lives in
    // `outputDir`, which is intentionally not deleted — the caller (the
    // CLI in chunk 07) owns that artifact's lifecycle.
    try {
      await fsp.rm(workDir, { recursive: true, force: true });
    } catch (_) {
      // Silent; cleanup is non-blocking.
    }
  }
}

/**
 * Library-mode entry: rebuild every `.zip` in `directory`, write per-package
 * artifacts to `<engagementsRoot>/<engagementId>/<package>/`, and emit a
 * library-level rollup at `<engagementsRoot>/<engagementId>/_rebuild-rollup.{html,md}`.
 *
 * Pure library-shaped: no console output, no spinner, no `process.exit`. The
 * CLI's `rebuild-library` action wraps this with display + exit logic.
 *
 * @param {string} directory
 * @param {Object} opts
 * @param {string}   opts.engagementId
 * @param {string}   [opts.engagementsRoot='./engagements']
 * @param {'safe'|'assisted'|'full'} [opts.mode='safe']
 * @param {'wcag21'|'wcag22'}        [opts.standard='wcag22']
 * @param {Object}   [opts.brandConfig]   - brand object passed to renderers; null OK
 * @param {string}   [opts.brandConfigPath]
 * @param {string}   [opts.packageType='auto']
 * @param {string}   [opts.browser='chromium']
 * @param {number}   [opts.timeoutDynamic=30000]
 * @param {AbortSignal} [opts.signal]
 * @param {Function} [opts.audit]   - audit() override (deps injection for tests)
 * @param {Function} [opts.verify]  - verify() override (deps injection for tests)
 * @param {Function} [opts.writeReports] - writeReports override
 * @param {Function} [opts.renderRebuildDiff]
 * @param {Function} [opts.renderRebuildSummary]
 * @returns {Promise<{
 *   results: Array<{ packageName: string, exitCode: number, verification: Object|null, manifestPath: string|null, rebuiltZipPath: string|null }>,
 *   rollupHtmlPath: string,
 *   rollupMdPath: string,
 *   totals: { resolved: number, remaining: number, introduced: number }
 * }>}
 */
async function rebuildLibrary(directory, opts) {
  const o = opts || {};
  if (!o.engagementId) throw new Error('rebuildLibrary: opts.engagementId is required');

  const engagementsRoot = o.engagementsRoot || './engagements';
  const mode = o.mode || 'safe';
  const standard = o.standard || 'wcag22';
  const packageType = o.packageType || 'auto';
  const browser = o.browser || 'chromium';
  const timeoutDynamic = typeof o.timeoutDynamic === 'number' ? o.timeoutDynamic : 30000;

  const doAudit = o.audit || require('../index').audit;
  const doVerify = o.verify || require('./verify').verify;
  const writeReports = o.writeReports || require('../reporter').writeReports;
  const renderDiff = o.renderRebuildDiff || require('../reporter/rebuild-diff').renderRebuildDiff;
  const renderSummary =
    o.renderRebuildSummary || require('../reporter/rebuild-summary').renderRebuildSummary;
  const { buildRollupMarkdown, buildRollupHtml } = require('../reporter/rebuild-rollup');

  // Find every .zip in `directory`. Sorted for determinism.
  const entries = await fsp.readdir(directory);
  const zipFiles = entries
    .filter((e) => e.toLowerCase().endsWith('.zip'))
    .sort()
    .map((e) => path.resolve(directory, e));

  const engagementDir = path.resolve(engagementsRoot, o.engagementId);
  await fsp.mkdir(engagementDir, { recursive: true });

  const results = [];

  for (const zipPath of zipFiles) {
    const packageName = path.basename(zipPath);
    const packageBaseName = path.basename(zipPath, '.zip');
    const packageDir = path.join(engagementDir, packageBaseName);
    await fsp.mkdir(packageDir, { recursive: true });

    let exitCode = 2;
    let verification = null;
    let manifestPath = null;
    let rebuiltZipPath = null;

    try {
      // 1. Audit (reuse fresh results.json if present).
      const auditResultsPath = path.join(packageDir, 'results.json');
      let auditResults = null;
      try {
        const [auditStat, inputStat] = await Promise.all([
          fsp.stat(auditResultsPath),
          fsp.stat(zipPath)
        ]);
        if (auditStat.mtimeMs >= inputStat.mtimeMs) {
          auditResults = JSON.parse(await fsp.readFile(auditResultsPath, 'utf8'));
        }
      } catch (_) {
        // No existing results.json — fall through to a fresh audit.
      }
      if (!auditResults) {
        auditResults = await doAudit(zipPath, {
          standard,
          packageType,
          browser,
          timeoutDynamic,
          packagePath: zipPath
        });
        await writeReports({
          scorecard: auditResults.scorecard,
          violations: auditResults.violations,
          manualReview: auditResults.manualReview,
          scos: auditResults.scos,
          dynamicReport: auditResults.dynamicReport,
          fixesApplied: auditResults.fixesApplied,
          options: {
            output: packageDir,
            standard,
            packageType: auditResults.packageType,
            packagePath: zipPath,
            engagementId: o.engagementId,
            brandConfigPath: o.brandConfigPath
          }
        });
      }

      // 2. Rebuild.
      const { manifest, rebuiltZipPath: rzPath } = await rebuild(zipPath, auditResults, {
        mode,
        standard,
        engagementId: o.engagementId,
        packageName,
        outputDir: packageDir,
        signal: o.signal,
        // v4.1: thread LLM gating + model through to per-package rebuilds.
        llmProvider: o.llmProvider,
        llmKeyFromEnv: o.llmKeyFromEnv,
        llmModel: o.llmModel
      });

      // 3. Deferred-tier short-circuit: render summary only, no zip on disk,
      // empty patches array. Exit 0.
      if (!rzPath) {
        const summaryPath = path.join(packageDir, 'rebuild-summary.html');
        await renderSummary(manifest, o.brandConfig || null, summaryPath);
        const fakeManifestPath = path.join(packageDir, 'rebuild-manifest.json');
        await fsp.writeFile(
          fakeManifestPath,
          JSON.stringify(manifest, null, 2),
          'utf8'
        );
        results.push({
          packageName,
          exitCode: 0,
          verification: null,
          manifestPath: fakeManifestPath,
          rebuiltZipPath: null
        });
        continue;
      }

      // 4. Verify (explicit allowlist — keeps `fix:true` etc. from leaking).
      const verifyResult = await doVerify(rzPath, auditResults, {
        standard,
        packageType,
        browser,
        timeoutDynamic,
        signal: o.signal || null
      });
      manifest.verification = {
        before: verifyResult.before,
        after: verifyResult.after,
        resolved: verifyResult.resolved,
        introduced: verifyResult.introduced,
        remaining: verifyResult.remaining
      };
      verification = manifest.verification;

      // 5. Write artifacts.
      manifestPath = path.join(packageDir, 'rebuild-manifest.json');
      const diffPath = path.join(packageDir, 'rebuild-diff.html');
      const summaryPath = path.join(packageDir, 'rebuild-summary.html');
      const outputZipPath = path.join(packageDir, 'rebuilt.zip');

      if (verifyResult.hasRegression) {
        // Regression: write manifest + summary (banner) but NOT rebuilt.zip.
        await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
        await renderSummary(manifest, o.brandConfig || null, summaryPath);
        results.push({
          packageName,
          exitCode: 2,
          verification,
          manifestPath,
          rebuiltZipPath: null
        });
        continue;
      }

      await fsp.copyFile(rzPath, outputZipPath);
      rebuiltZipPath = outputZipPath;
      const { writeManifest } = require('./manifest');
      writeManifest(manifest, manifestPath);
      await renderDiff(manifest, o.brandConfig || null, diffPath);
      await renderSummary(manifest, o.brandConfig || null, summaryPath);

      exitCode = verifyResult.remaining === 0 ? 0 : 1;
    } catch (_err) {
      // Per-package error: surface as exitCode=2 in the rollup but keep going.
      exitCode = 2;
    }

    results.push({
      packageName,
      exitCode,
      verification,
      manifestPath,
      rebuiltZipPath
    });
  }

  // Render rollup.
  const rollupHtmlPath = path.join(engagementDir, '_rebuild-rollup.html');
  const rollupMdPath = path.join(engagementDir, '_rebuild-rollup.md');
  await fsp.writeFile(rollupHtmlPath, buildRollupHtml(o.engagementId, results), 'utf8');
  await fsp.writeFile(rollupMdPath, buildRollupMarkdown(o.engagementId, results), 'utf8');

  // Aggregate totals.
  const totals = { resolved: 0, remaining: 0, introduced: 0 };
  for (const r of results) {
    if (r.verification) {
      totals.resolved += r.verification.resolved || 0;
      totals.remaining += r.verification.remaining || 0;
      totals.introduced += r.verification.introduced || 0;
    }
  }

  return { results, rollupHtmlPath, rollupMdPath, totals };
}

module.exports = { rebuild, rebuildLibrary };
