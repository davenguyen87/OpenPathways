/**
 * Transformer registry — pure module that scans `src/transformers/` for
 * full-tier transformer modules and returns them sorted by `id`.
 *
 * v5 introduces a second registry alongside the v4 fixer registry. Where a
 * Fixer operates on a single file (see `src/rebuild/index.js#loadFixers`),
 * a Transformer operates on the whole extracted package and emits a
 * coordinated bundle of patches. The registry mechanics mirror the fixer
 * loader (defensive filtering, require-cache bypass, sort by id) but are
 * extracted to their own module because the orchestrator now loads two
 * registries and inlining both bloats `src/rebuild/index.js`.
 *
 * A module is accepted when, after loading, it satisfies:
 *
 *   - `tier === 'full'`
 *   - both `canTransform` and `apply` are functions
 *
 * Anything else (a fixer accidentally placed in the directory, a partial
 * stub, a malformed `module.exports`) is silently skipped — the same shape
 * as the fixer loader. Duplicate ids are deduplicated by keeping the first
 * encountered after the sort.
 *
 * The directory itself is allowed not to exist: in the early build stages
 * (chunks 03/04/05 ship transformers; 01 is wired before they land) the
 * orchestrator must still be callable. Returns an empty array in that case.
 */

const fs = require('fs');
const path = require('path');

/**
 * Load every full-tier transformer in `transformersDir`.
 *
 * @param {string} transformersDir
 * @returns {Array} transformer modules, sorted by id, deduplicated by id
 */
function loadTransformers(transformersDir) {
  let entries;
  try {
    entries = fs.readdirSync(transformersDir);
  } catch (_) {
    // Directory does not exist (transformers haven't shipped yet) or is
    // unreadable. Return empty so the orchestrator's transformer pass
    // becomes a no-op rather than a failure.
    return [];
  }

  const transformers = [];
  for (const entry of entries) {
    if (!entry.endsWith('.js')) continue;
    const full = path.join(transformersDir, entry);
    let mod;
    try {
      // Bypass require cache: tests construct transformersDir fresh per
      // case and can otherwise see a stale module from a previous test
      // file. Mirrors the v4 `loadFixers` pattern in src/rebuild/index.js.
      delete require.cache[require.resolve(full)];
      mod = require(full);
    } catch (_) {
      continue;
    }
    if (!mod || mod.tier !== 'full') continue;
    if (typeof mod.canTransform !== 'function' || typeof mod.apply !== 'function') continue;
    transformers.push(mod);
  }

  transformers.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Dedupe by id, keeping the first occurrence after the sort. A repeated
  // id is a packaging bug; the second copy is dropped silently rather than
  // throwing, matching the loader's "be lenient with the on-disk layout"
  // posture.
  const seen = new Set();
  const out = [];
  for (const t of transformers) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

module.exports = { loadTransformers };
