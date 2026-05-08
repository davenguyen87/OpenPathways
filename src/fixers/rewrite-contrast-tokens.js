/**
 * Rewrite CSS custom-property (token) values so that failing color pairs
 * meet WCAG 2.1 AA contrast requirements:
 *   - 1.4.3 (text contrast): ≥4.5:1
 *   - 1.4.11 (non-text contrast): ≥3:1
 *
 * Strategy:
 *   Only acts when the violation's offending color is expressed as a CSS
 *   custom property (`--token-name`) and a calibrated replacement value
 *   is available in the fixer's palette map. Rewrites the `:root` (or
 *   whichever block declares the token) declaration to a compliant value.
 *
 * Decline policy:
 *   - Violation involves an ad-hoc hex/rgb literal not behind a token →
 *     deferred with reason "ad-hoc color literal — needs author review".
 *   - No palette mapping exists for the offending token → deferred with
 *     reason "no calibrated replacement for token <name> — needs author review".
 *   - Violation criterion is neither 1.4.3 nor 1.4.11 → canFix returns false.
 *   - File is not CSS (or an HTML file containing inline <style>) → canFix
 *     returns false; the fixer only rewrites CSS token declarations.
 *
 * Palette:
 *   The caller may inject a `palette` option into the file object or pass it
 *   via the `violations` array's first entry's `_palette` meta-field (test
 *   convention). In production the orchestrator wires `config/brand.json` as
 *   the default palette. The palette maps token names to `{ compliant }` objects
 *   where `compliant` is the new value that satisfies the criterion.
 *
 *   Palette shape:
 *   {
 *     "--token-name": {
 *       text: "#new-value",       // for 1.4.3 (text contrast)
 *       nonText: "#new-value"     // for 1.4.11 (non-text contrast)
 *     }
 *   }
 *   If a token only provides `text` (or `nonText`), only the matching
 *   criterion is actionable.
 *
 * Patch shape:
 *   Each patch's `before`/`after` spans only the declaration line where the
 *   token value was rewritten, plus the standard context window from buildPatch.
 *   The `rationale` carries `{ tokenName, oldValue, newValue }` encoded as a
 *   human-readable string.
 */

const { buildPatch, revertPatch, applyMods } = require('../rebuild/types');

const FIXER_ID = 'rewrite-contrast-tokens';
const CRITERIA = ['1.4.3', '1.4.11'];

// ── WCAG contrast math ──────────────────────────────────────────────────────
// Implements (L1 + 0.05) / (L2 + 0.05) over WCAG relative luminance.
// No external library; formula is from WCAG 2.1 success criterion 1.4.3.

/**
 * Parse a hex color string (#rrggbb or #rgb) into [r, g, b] (0–255).
 * Returns [0, 0, 0] for unrecognised input.
 * @param {string} hex
 * @returns {[number, number, number]}
 */
function parseHex(hex) {
  const h = hex.replace(/^#/, '');
  if (h.length === 3) {
    return [
      parseInt(h[0] + h[0], 16),
      parseInt(h[1] + h[1], 16),
      parseInt(h[2] + h[2], 16)
    ];
  }
  if (h.length === 6) {
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16)
    ];
  }
  return [0, 0, 0];
}

/**
 * WCAG relative luminance for a single channel value in [0, 1].
 * @param {number} v8 - channel value in [0, 255]
 * @returns {number}
 */
function channelLuminance(v8) {
  const v = v8 / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/**
 * WCAG relative luminance for a hex color string.
 * @param {string} hex
 * @returns {number}
 */
function relativeLuminance(hex) {
  const [r, g, b] = parseHex(hex);
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

/**
 * WCAG contrast ratio between two hex colors.
 * @param {string} hexA
 * @param {string} hexB
 * @returns {number}
 */
function contrastRatio(hexA, hexB) {
  const la = relativeLuminance(hexA);
  const lb = relativeLuminance(hexB);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

// ── CSS token rewriting helpers ─────────────────────────────────────────────

/**
 * Detect whether `colorValue` looks like a CSS custom property reference
 * (e.g. `var(--foo)` or bare `--foo`) vs. an ad-hoc literal.
 *
 * @param {string} value
 * @returns {string|null} token name (e.g. `--foo`) or null if literal
 */
function extractTokenName(value) {
  if (!value) return null;
  // Match var(--token-name) or var(--token-name, fallback)
  const varMatch = value.match(/var\s*\(\s*(--[\w-]+)/);
  if (varMatch) return varMatch[1];
  // Match bare --token-name (some authors write this directly in declarations)
  const bareMatch = value.trim().match(/^(--[\w-]+)$/);
  if (bareMatch) return bareMatch[1];
  return null;
}

/**
 * Find the declaration(s) of `tokenName` in `cssContent` and return a list of
 * { offset, originalText, replacementText } for each site.
 *
 * Matches lines of the form:
 *   --token-name: <value>;
 *
 * @param {string} cssContent
 * @param {string} tokenName - e.g. `--color-primary`
 * @param {string} newValue
 * @returns {Array<{offset: number, originalText: string, replacementText: string, oldValue: string}>}
 */
function findTokenDeclarations(cssContent, tokenName, newValue) {
  const results = [];
  // Match: optional whitespace, token name, colon, value up to semicolon
  const re = new RegExp(
    `([ \\t]*${tokenName.replace(/[-]/g, '\\-')}\\s*:\\s*)([^;\\n]+)(;)`,
    'g'
  );
  let m;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(cssContent)) !== null) {
    const originalText = m[0];
    const oldValue = m[2].trim();
    // Skip if the value is already the replacement (idempotent).
    if (oldValue === newValue) continue;
    const replacementText = m[1] + newValue + m[3];
    results.push({
      offset: m.index,
      originalText,
      replacementText,
      oldValue
    });
  }
  return results;
}

// ── Module interface ────────────────────────────────────────────────────────

module.exports = {
  id: FIXER_ID,
  name: 'Rewrite CSS contrast tokens to nearest compliant palette value',
  supported: ['scorm12', 'scorm2004', 'aicc'],
  confidence: 'definitive',
  criteria: CRITERIA,
  criterion: '1.4.3', // primary (the orchestrator may use either field)
  triage: 'auto-fix safe',
  tier: 'safe',
  provenance: 'deterministic',

  canFix(file, violation) {
    if (!violation) return false;
    if (!CRITERIA.includes(violation.criterion)) return false;
    // Only act on CSS files or HTML files (which may contain inline <style>).
    if (!file || (!file.isCss && !file.isHtml)) return false;
    // We can only fix token-based violations; literal colors are declined
    // during apply() with a deferred entry.
    return true;
  },

  /**
   * @param {{ path: string, content: string, isCss?: boolean, isHtml?: boolean }} file
   * @param {Array<Object>} violations
   * @param {{ palette?: Object }} [packageContext]
   * @returns {Promise<{ changed: boolean, newContent: string, patches: Array, deferred: Array, log: string[] }>}
   */
  async apply(file, violations, packageContext) {
    const log = [];
    const patches = [];
    const deferred = [];

    if (!file || typeof file.content !== 'string') {
      return { changed: false, newContent: (file && file.content) || '', patches, deferred, log };
    }

    // Resolve palette: prefer packageContext.palette, then file._palette (test
    // injection), then an empty map (nothing to do).
    const palette =
      (packageContext && packageContext.palette) ||
      file._palette ||
      {};

    const original = file.content;
    const mods = [];
    const usedOffsets = new Set();

    for (const violation of (violations || [])) {
      if (!violation || !CRITERIA.includes(violation.criterion)) continue;
      const isNonText = violation.criterion === '1.4.11';
      const minRatio = isNonText ? 3 : 4.5;

      // Extract the offending token name from the violation message or snippet.
      // The checks embed the offending color values in the message; we look for
      // a var() reference or a bare token name.
      const msgAndSnippet = `${violation.message || ''} ${violation.snippet || ''}`;
      const tokenMatch = msgAndSnippet.match(/var\s*\(\s*(--[\w-]+)/);
      const tokenName = tokenMatch ? tokenMatch[1] : extractTokenName(violation.color || '');

      if (!tokenName) {
        // Ad-hoc literal or unknown format — decline.
        deferred.push({
          criterion: violation.criterion,
          triage: 'auto-fix safe',
          reason: 'ad-hoc color literal — needs author review',
          file: file.path,
          line: violation.line || null
        });
        log.push(`Deferred: ad-hoc color literal (no token) in violation at line ${violation.line}`);
        continue;
      }

      const tokenEntry = palette[tokenName];
      if (!tokenEntry) {
        deferred.push({
          criterion: violation.criterion,
          triage: 'auto-fix safe',
          reason: `no calibrated replacement for token ${tokenName} — needs author review`,
          file: file.path,
          line: violation.line || null
        });
        log.push(`Deferred: no palette entry for token ${tokenName}`);
        continue;
      }

      const newValue = isNonText ? tokenEntry.nonText : tokenEntry.text;
      if (!newValue) {
        deferred.push({
          criterion: violation.criterion,
          triage: 'auto-fix safe',
          reason: `no calibrated replacement for token ${tokenName} — needs author review`,
          file: file.path,
          line: violation.line || null
        });
        log.push(`Deferred: palette entry for ${tokenName} lacks ${isNonText ? 'nonText' : 'text'} value`);
        continue;
      }

      // Find the token declaration(s) in the CSS content.
      const sites = findTokenDeclarations(original, tokenName, newValue);
      if (sites.length === 0) {
        log.push(`Token ${tokenName} not found as a declaration in ${file.path}; skipping`);
        continue;
      }

      for (const site of sites) {
        if (usedOffsets.has(site.offset)) continue;
        usedOffsets.add(site.offset);

        mods.push({
          offset: site.offset,
          originalText: site.originalText,
          replacementText: site.replacementText
        });

        patches.push(
          buildPatch({
            fixer: FIXER_ID,
            criterion: violation.criterion,
            confidence: 'definitive',
            file: file.path,
            content: original,
            originalOffset: site.offset,
            originalText: site.originalText,
            replacementText: site.replacementText,
            rationale: `Token ${tokenName} rewritten from "${site.oldValue}" to "${newValue}" to achieve ≥${minRatio}:1 contrast (${violation.criterion}).`
          })
        );
        log.push(
          `Rewrote ${tokenName}: "${site.oldValue}" → "${newValue}" at offset ${site.offset}`
        );
      }
    }

    return {
      changed: patches.length > 0,
      newContent: applyMods(original, mods),
      patches,
      deferred,
      log
    };
  },

  async revert(file, patch) {
    return revertPatch(file, patch);
  },

  async fix(file, violations) {
    const result = await this.apply(file, violations);
    return { changed: result.changed, newContent: result.newContent, log: result.log };
  }
};
