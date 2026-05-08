/**
 * Rebuild orchestrator.
 *
 * Consumes audit results + the original `.zip` and produces a remediated
 * `.zip` plus a manifest of every patch. v4 ships safe-tier only;
 * `--mode assisted` and `--mode full` short-circuit to a deferred-feature
 * notice and write nothing to disk (see PRD v4 § "Tier dispatch").
 *
 * Responsibilities (chunk 01 only):
 *   1. Tier dispatch.
 *   2. Unpack the input zip into a temp working directory.
 *   3. Build a fixer registry (every safe-tier fixer in `fixersDir`).
 *   4. Group violations by file; let the first fixer that claims each
 *      violation own it; deferred otherwise.
 *   5. Apply per-file in declared (id-sorted) order, threading content
 *      through each fixer's apply().
 *   6. Validate each fixer's output (HTML reparses, JSON parses, CSS brace
 *      balance) and drop the patch set if invalid.
 *   7. Repackage to a new zip.
 *   8. Hash input + output, populate manifest, return.
 *
 * Out of scope here: re-audit verification (chunk 02), undo (08), diff /
 * summary reports (05/06), CLI wiring (07).
 *
 * @typedef {import('./types').Patch} Patch
 * @typedef {import('./types').RebuildManifest} RebuildManifest
 */

const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cheerio = require('cheerio');

const { createManifest, addPatch, addDeferred } = require('./manifest');
const { unpack, pack, sha256 } = require('./packager');

const DEFAULT_LOGGER = {
  info: (msg) => process.stdout.write(`${msg}\n`),
  warn: (msg) => process.stderr.write(`${msg}\n`)
};

/**
 * Load every safe-tier fixer in `fixersDir`. Filters defensively: a file
 * without `tier === 'safe'` or without both `canFix` and `apply` is
 * skipped. Fixers are sorted by `id` ascending so claim-order is
 * deterministic across machines (filesystem readdir order is not).
 *
 * @param {string} fixersDir
 * @returns {Array}
 */
function loadFixers(fixersDir) {
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
    if (!mod || mod.tier !== 'safe') continue;
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
 * Main entry point. See module docstring for behavior.
 *
 * @param {string} packagePath
 * @param {{ violations?: Array, [k: string]: any }} auditResults
 * @param {object} [opts]
 * @returns {Promise<{ manifest: RebuildManifest, rebuiltZipPath: string|null }>}
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

  // Tier dispatch: assisted/full are stubs in v4. We still build a manifest
  // so callers can introspect what *would* be deferred. No zip is written.
  if (mode === 'assisted' || mode === 'full') {
    const manifest = createManifest({
      engagementId,
      packageName,
      inputZipSha256,
      mode,
      standard,
      createdAt: now().toISOString()
    });
    // Manifest serializer requires a non-empty outputZipSha256. Since no
    // zip was written, set it equal to the input hash; the empty `patches`
    // array + populated `deferred` makes the no-op semantically clear.
    manifest.outputZipSha256 = inputZipSha256;

    for (const v of violations) {
      addDeferred(manifest, {
        criterion: v.criterion || '',
        triage: v.triage || 'auto-fix safe',
        reason: `tier=${mode} not implemented in v4 — deferred to v4.1/v5`,
        file: v.file || '',
        line: typeof v.line === 'number' ? v.line : 0
      });
    }
    logger.info(
      `[rebuild] mode=${mode} is deferred to v4.1/v5; ${manifest.deferred.length} finding(s) marked deferred, no .zip written`
    );
    return { manifest, rebuiltZipPath: null };
  }

  // Safe tier — the real path.
  const manifest = createManifest({
    engagementId,
    packageName,
    inputZipSha256,
    mode: 'safe',
    standard,
    createdAt: now().toISOString()
  });

  // Working dir under os.tmpdir(); cleaned up in finally.
  const workDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), `prism-rebuild-${crypto.randomBytes(4).toString('hex')}-`)
  );
  // Output path: `<packageName>.rebuilt.zip`, replacing trailing `.zip` if
  // present (so `foo.zip` -> `foo.rebuilt.zip`, not `foo.zip.rebuilt.zip`).
  const outputDir = o.outputDir || (await fsp.mkdtemp(
    path.join(os.tmpdir(), `prism-rebuild-out-${crypto.randomBytes(4).toString('hex')}-`)
  ));
  await fsp.mkdir(outputDir, { recursive: true });
  const baseName = packageName.toLowerCase().endsWith('.zip')
    ? packageName.slice(0, -4)
    : packageName;
  const rebuiltZipPath = path.join(outputDir, `${baseName}.rebuilt.zip`);

  try {
    await unpack(packagePath, workDir);

    const fixers = loadFixers(fixersDir);
    const grouped = groupByFile(violations);
    // Build the per-package sibling list once so fixers like
    // `wire-captions-track` can locate companion files (.vtt etc.).
    const siblings = listSiblings(workDir);
    const packageContext = { siblings };

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

    await pack(workDir, rebuiltZipPath, manifest);

    const outputZipSha256 = await sha256(rebuiltZipPath);
    manifest.inputZipSha256 = inputZipSha256;
    manifest.outputZipSha256 = outputZipSha256;

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
        signal: o.signal
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
