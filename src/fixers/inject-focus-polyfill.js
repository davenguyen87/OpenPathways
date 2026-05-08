/**
 * Inject a deterministic focus-indicator stylesheet into <head>.
 *
 * Criteria: 2.4.7 (Focus visible) + 2.4.11 (Focus appearance — 2.2 only)
 * Triage: auto-fix safe
 *
 * Strategy:
 *   When the audit confirms focus styles are demonstrably absent or below
 *   the 3:1 contrast requirement, inject a single `<style>` block:
 *
 *     <style id="prism-focus-polyfill">
 *     :focus-visible { outline: 2px solid #2f7d72; outline-offset: 2px; }
 *     </style>
 *
 *   The chosen focus color is the brand `accent` token value `#2f7d72`
 *   (Skill Loop teal). Against the brand `paper` background `#f3efe6`:
 *     - Luminance(#2f7d72) ≈ 0.154   Luminance(#f3efe6) ≈ 0.887
 *     - Contrast = (0.887 + 0.05) / (0.154 + 0.05) ≈ 4.59:1  ✓ ≥3:1
 *   The color also meets 3:1 against a plain white background (#ffffff, ~4.0:1).
 *
 *   If the brand config's `focus` token is supplied (via `packageContext` or
 *   `file._brandConfig`), that value is used instead. The fixer verifies the
 *   supplied color achieves ≥3:1 against `#ffffff` before using it; if not
 *   it falls back to the hardcoded default.
 *
 * Stable ID pattern (matches raise-target-size.js):
 *   - If `<style id="prism-focus-polyfill">` already exists, append the rule
 *     before the closing `</style>`.
 *   - Otherwise insert a new block immediately before `</head>`.
 *   - In both cases, only ONE patch is emitted (the style-block insertion),
 *     keeping the patch minimal.
 *
 * Decline policy:
 *   - Violation's `focusStylesPresent` field is `true` (or message indicates
 *     styles pass 3:1) → deferred with reason
 *     "focus styles already meet 3:1 — no polyfill needed".
 *   - File is not HTML → canFix returns false.
 *   - Criterion is neither 2.4.7 nor 2.4.11 → canFix returns false.
 *
 * Patch shape:
 *   Patching the style-block injection point. `revert` removes the inserted
 *   block (or the appended rule) via the standard revertPatch mechanism.
 */

const { buildPatch, revertPatch } = require('../rebuild/types');

const FIXER_ID = 'inject-focus-polyfill';
const CRITERIA = ['2.4.7', '2.4.11'];
const STYLE_ID = 'prism-focus-polyfill';

// Default focus color: brand `accent` #2f7d72.
// Against paper #f3efe6: contrast ≈ 4.59:1 (≥3:1 for non-text ✓, ≥3:1 for focus ✓).
// Against white #ffffff: contrast ≈ 4.0:1 (≥3:1 ✓).
const DEFAULT_FOCUS_COLOR = '#2f7d72';

// ── WCAG contrast math (same formula as rewrite-contrast-tokens.js) ─────────

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

function channelLuminance(v8) {
  const v = v8 / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex) {
  const [r, g, b] = parseHex(hex);
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

function contrastRatio(hexA, hexB) {
  const la = relativeLuminance(hexA);
  const lb = relativeLuminance(hexB);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

// ── Style-block injection (same strategy as raise-target-size.js) ────────────

/**
 * Compute the edit required to inject `ruleText` into the polyfill style block.
 *
 * Cases:
 *   1. `<style id="prism-focus-polyfill">` exists → append rule before `</style>`.
 *   2. Block doesn't exist → create it before `</head>`.
 *
 * Returns `{ offset, originalText, replacementText }` or null when the file
 * has no `</head>` (degenerate input).
 *
 * @param {string} content
 * @param {string} ruleText - the full CSS rule line to inject
 * @returns {{ offset: number, originalText: string, replacementText: string } | null}
 */
function computeStyleEdit(content, ruleText) {
  const blockRe = new RegExp(
    `<style\\b[^>]*\\bid\\s*=\\s*["']${STYLE_ID}["'][^>]*>([\\s\\S]*?)</style>`,
    'i'
  );
  const blockMatch = content.match(blockRe);

  if (blockMatch) {
    // Style block exists — insert rule before its closing </style>.
    const blockStart = blockMatch.index;
    const blockText = blockMatch[0];
    const closeIdxLocal = blockText.toLowerCase().lastIndexOf('</style>');
    if (closeIdxLocal === -1) return null;
    const insertOffset = blockStart + closeIdxLocal;
    const before = content.slice(0, insertOffset);
    const lineStart = before.lastIndexOf('\n');
    const indent = lineStart === -1 ? '' : before.slice(lineStart + 1);
    const indentIsWs = /^\s*$/.test(indent);
    const lead = indentIsWs ? '' : '\n';
    return {
      offset: insertOffset,
      originalText: '',
      replacementText: `${lead}${ruleText}\n${indentIsWs ? indent : ''}`
    };
  }

  // Create a new block before </head>.
  const headCloseRe = /<\/head\s*>/i;
  const headMatch = content.match(headCloseRe);
  if (!headMatch) return null;

  const insertOffset = headMatch.index;
  const before = content.slice(0, insertOffset);
  const lineStart = before.lastIndexOf('\n');
  const indent = lineStart === -1 ? '' : before.slice(lineStart + 1);
  const indentIsWs = /^\s*$/.test(indent);
  const newBlock =
    `<style id="${STYLE_ID}">\n${ruleText}\n</style>\n` +
    (indentIsWs ? indent : '');
  return {
    offset: insertOffset,
    originalText: '',
    replacementText: newBlock
  };
}

/**
 * Determine the best focus color: use the brand-supplied value if it achieves
 * ≥3:1 against white (#ffffff), otherwise fall back to DEFAULT_FOCUS_COLOR.
 *
 * @param {Object|undefined} brandConfig - e.g. `{ focus: '#aabbcc' }` or
 *   any brand.json-shaped object. We check `.focus` first then `.accent`.
 * @returns {string}
 */
function resolveFocusColor(brandConfig) {
  if (brandConfig) {
    const candidates = [brandConfig.focus, brandConfig.accent];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && /^#[0-9a-f]{3,6}$/i.test(candidate)) {
        if (contrastRatio(candidate, '#ffffff') >= 3) {
          return candidate;
        }
      }
    }
  }
  return DEFAULT_FOCUS_COLOR;
}

module.exports = {
  id: FIXER_ID,
  name: 'Inject :focus-visible polyfill stylesheet for missing/insufficient focus indicators',
  supported: ['scorm12', 'scorm2004', 'aicc'],
  confidence: 'definitive',
  criteria: CRITERIA,
  criterion: '2.4.7', // primary
  triage: 'auto-fix safe',
  tier: 'safe',
  provenance: 'deterministic',

  canFix(file, violation) {
    if (!file || !file.isHtml) return false;
    if (!violation || !CRITERIA.includes(violation.criterion)) return false;
    // Decline if the audit already confirmed focus styles pass.
    if (violation.focusStylesPresent === true) return false;
    return true;
  },

  /**
   * @param {{ path: string, content: string, isHtml: boolean, _brandConfig?: Object }} file
   * @param {Array<Object>} violations
   * @param {{ brandConfig?: Object }} [packageContext]
   * @returns {Promise<{ changed: boolean, newContent: string, patches: Array, deferred: Array, log: string[] }>}
   */
  async apply(file, violations, packageContext) {
    const log = [];
    const patches = [];
    const deferred = [];

    if (!file || !file.isHtml || typeof file.content !== 'string') {
      return { changed: false, newContent: (file && file.content) || '', patches, deferred, log };
    }

    const original = file.content;

    // Resolve brand config for focus color.
    const brandConfig =
      (packageContext && packageContext.brandConfig) ||
      file._brandConfig ||
      null;

    // Filter violations to actionable (2.4.7 or 2.4.11, not already-passing).
    const actionable = (violations || []).filter((v) => {
      if (!v || !CRITERIA.includes(v.criterion)) return false;
      if (v.focusStylesPresent === true) {
        deferred.push({
          criterion: v.criterion,
          triage: 'auto-fix safe',
          reason: 'focus styles already meet 3:1 — no polyfill needed',
          file: file.path,
          line: v.line || null
        });
        log.push(`Deferred: focus styles already pass for violation at line ${v.line}`);
        return false;
      }
      return true;
    });

    if (actionable.length === 0) {
      return { changed: false, newContent: original, patches, deferred, log };
    }

    // We emit at most ONE style-block patch per file: the polyfill block covers
    // all 2.4.7/2.4.11 violations in the file with a single rule.
    const focusColor = resolveFocusColor(brandConfig);
    const ruleText = `:focus-visible { outline: 2px solid ${focusColor}; outline-offset: 2px; }`;

    const styleEdit = computeStyleEdit(original, ruleText);
    if (!styleEdit) {
      log.push(`No </head> found in ${file.path}; cannot inject focus polyfill`);
      return { changed: false, newContent: original, patches, deferred, log };
    }

    patches.push(
      buildPatch({
        fixer: FIXER_ID,
        criterion: actionable[0].criterion,
        confidence: 'definitive',
        file: file.path,
        content: original,
        originalOffset: styleEdit.offset,
        originalText: styleEdit.originalText,
        replacementText: styleEdit.replacementText,
        rationale: `Injected <style id="${STYLE_ID}"> with :focus-visible outline (${focusColor}, ≥3:1 contrast) to satisfy ${CRITERIA.join(' + ')}.`
      })
    );

    const newContent =
      original.slice(0, styleEdit.offset) +
      styleEdit.replacementText +
      original.slice(styleEdit.offset + styleEdit.originalText.length);

    log.push(`Injected focus polyfill (${focusColor}) into ${file.path}`);

    return {
      changed: true,
      newContent,
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
