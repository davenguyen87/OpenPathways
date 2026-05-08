/**
 * Raise target size for elements flagged below the WCAG 2.5.8 24x24 minimum.
 *
 * Strategy:
 *   - Tag the offending element with a stable class derived from a hash of the
 *     element's tag + serialized attributes + position-index.
 *   - Inject a CSS rule for that class — `min-width: 24px; min-height: 24px;` —
 *     into a `<style id="prism-target-size">` block in <head>. Create the
 *     block immediately before </head> if it doesn't already exist; otherwise
 *     append the new rule before the block's closing </style>.
 *
 * Why a generated class instead of using the violation's selector:
 *   The 2.5.8 check does not currently emit a stable CSS selector. Snippets
 *   are not always safely convertible to one. Adding a deterministic class
 *   is fully reversible and avoids ambiguous selector synthesis.
 *
 * Why TWO patches per fixed element:
 *   Each remediated element touches two regions of the file: (a) the element's
 *   open tag in <body>, (b) the <style id="prism-target-size"> block in <head>.
 *   Bundling both edits into a single patch would force the patch's
 *   originalText to span everything between, embedding most of the page —
 *   the PRD's diff-render rule forbids that. Instead we emit two patches per
 *   fixed element: one class-addition patch in <body>, one rule-injection
 *   patch in <head>.
 *
 *   For two violations on one file (four patches total) we must not emit two
 *   style-block patches anchored at the same offset against the original —
 *   their `after` substrings would overlap and revert would fail. To preserve
 *   round-trip we build each subsequent style-block patch against the content
 *   produced by applying the previous style patch. Each later patch's
 *   before/after therefore reflects the actual adjacency it will have in the
 *   final file. Reverting in reverse-array order then restores byte-identical.
 *
 * Decline policy:
 *   - Violation has no `boundingBox` field -> decline (safe-tier; no guessing).
 *   - boundingBox shows a 24x24 bump would overlap (width + 24 > availableWidth
 *     or height + 24 > availableHeight) -> decline.
 *   - File is not HTML -> decline. The CSS variant of the 2.5.8 check fires on
 *     standalone .css files; rewriting those needs a different fixer.
 */

const crypto = require('crypto');
const cheerio = require('cheerio');
const { buildPatch, revertPatch, applyMods } = require('../rebuild/types');

const FIXER_ID = 'raise-target-size';
const CRITERION = '2.5.8';
const CLASS_PREFIX = 'prism-ts-';
const STYLE_ID = 'prism-target-size';
const RULE_DECLS = '{ min-width: 24px; min-height: 24px; }';

// Tag names the 2.5.8 check considers interactive targets. Mirrors the
// selector list in src/checks/2-5-8-target-size-minimum.js so the fixer
// only ever touches elements the check could have flagged.
const INTERACTIVE_TAGS = new Set(['button', 'a', 'input', 'summary']);
const INTERACTIVE_INPUT_TYPES = new Set(['button', 'submit', 'reset']);
const INTERACTIVE_ROLES = new Set(['button', 'link']);

module.exports = {
  id: FIXER_ID,
  name: 'Raise target size to WCAG 2.5.8 minimum (24x24)',
  supported: ['scorm12', 'scorm2004', 'aicc'],
  confidence: 'definitive',
  criterion: CRITERION,
  triage: 'auto-fix safe',
  tier: 'safe',
  provenance: 'deterministic',

  canFix(file, violation) {
    if (!file || !file.isHtml) return false;
    if (!violation || violation.criterion !== CRITERION) return false;
    return hasRoomForBump(violation.boundingBox);
  },

  async apply(file, violations) {
    const log = [];
    const patches = [];

    if (!file || !file.isHtml || typeof file.content !== 'string') {
      return { changed: false, newContent: (file && file.content) || '', patches, log };
    }

    const original = file.content;

    let $;
    try {
      $ = cheerio.load(original, {
        decodeEntities: false,
        sourceCodeLocationInfo: true,
        withStartIndices: true,
        withEndIndices: true
      });
    } catch (e) {
      log.push(`Could not parse HTML: ${e.message}`);
      return { changed: false, newContent: original, patches, log };
    }

    // Filter to actionable violations: 2.5.8, has boundingBox with room.
    const actionable = (violations || []).filter((v) => {
      if (!v || v.criterion !== CRITERION) return false;
      if (!hasRoomForBump(v.boundingBox)) {
        if (v) log.push(`Declined: violation lacks boundingBox or insufficient room (line ${v.line})`);
        return false;
      }
      return true;
    });

    if (actionable.length === 0) {
      return { changed: false, newContent: original, patches, log };
    }

    // Index every interactive element with an inline-style under-24 dimension.
    // Position-index is the order of discovery via this enumeration; stable
    // across runs because cheerio walks the DOM deterministically.
    const candidates = [];
    let posIndex = 0;
    $('button, a, input, summary, [role]').each((_, el) => {
      if (!isInteractive(el, $)) return;
      const loc = el.sourceCodeLocation && el.sourceCodeLocation.startTag;
      if (!loc) return;
      const style = ($(el).attr('style') || '').toLowerCase();
      const w = readPx(style, 'width');
      const h = readPx(style, 'height');
      if (w === null || h === null) return;
      if (w >= 24 && h >= 24) return;
      candidates.push({ el, loc, posIndex });
      posIndex += 1;
    });

    if (candidates.length === 0) {
      return { changed: false, newContent: original, patches, log };
    }

    // Pair each actionable violation with the first unused candidate at or
    // after its line. Stable: violations are taken in input order; candidates
    // are walked top-down. If the violation has no line, we still match the
    // first unused candidate (defensive — the check always emits a line).
    const usedCandidates = new Set();
    const pairs = [];
    for (const v of actionable) {
      const idx = candidates.findIndex((c, i) => {
        if (usedCandidates.has(i)) return false;
        if (typeof v.line !== 'number') return true;
        // Cheerio's startLine is 1-based; lineOf in the check is also 1-based.
        const candLine = c.loc.startLine;
        return candLine === v.line || candLine >= v.line;
      });
      if (idx === -1) {
        log.push(`No matching interactive element for violation at line ${v.line}`);
        continue;
      }
      usedCandidates.add(idx);
      pairs.push({ violation: v, candidate: candidates[idx] });
    }

    if (pairs.length === 0) {
      return { changed: false, newContent: original, patches, log };
    }

    // ── 1. Build class-addition mods/patches against the original ────────
    const classMods = [];
    for (const pair of pairs) {
      const { el, loc, posIndex: pi } = pair.candidate;
      const tagStart = loc.startOffset;
      const tagEnd = loc.endOffset;
      const tagText = original.slice(tagStart, tagEnd);

      const className = generateClassName(el, $, pi);
      const newTagText = injectClassAttribute(tagText, className);

      classMods.push({
        offset: tagStart,
        originalText: tagText,
        replacementText: newTagText,
        className,
        pair
      });
    }

    // Apply class mods against the original; we'll then sequentially apply
    // style mods against this evolving content so each style patch's
    // before/after reflects the adjacency it will have in the final file.
    let currentContent = applyMods(
      original,
      classMods.map((m) => ({
        offset: m.offset,
        originalText: m.originalText,
        replacementText: m.replacementText
      }))
    );

    // Emit class-addition patches (all built against the original; their
    // offsets are pairwise distinct so applyMods order is irrelevant).
    for (const m of classMods) {
      patches.push(
        buildPatch({
          fixer: FIXER_ID,
          criterion: CRITERION,
          confidence: 'definitive',
          file: file.path,
          content: original,
          originalOffset: m.offset,
          originalText: m.originalText,
          replacementText: m.replacementText,
          rationale: `Tagged target with .${m.className} so a 24x24 minimum-size CSS rule can be applied.`
        })
      );
      log.push(`Tagged element at offset ${m.offset} with class ${m.className}`);
    }

    // ── 2. Build style-block patches sequentially against evolving content
    for (const m of classMods) {
      const ruleText = `.${m.className} ${RULE_DECLS}`;
      const styleEdit = computeStyleEdit(currentContent, ruleText);
      if (!styleEdit) {
        log.push(`Could not locate <head> or </head> for ${m.className}; style patch skipped`);
        continue;
      }

      patches.push(
        buildPatch({
          fixer: FIXER_ID,
          criterion: CRITERION,
          confidence: 'definitive',
          file: file.path,
          content: currentContent,
          originalOffset: styleEdit.offset,
          originalText: styleEdit.originalText,
          replacementText: styleEdit.replacementText,
          rationale: `Injected min-width/min-height rule for .${m.className} into <style id="${STYLE_ID}"> so the target meets WCAG 2.5.8 (24x24).`
        })
      );

      currentContent =
        currentContent.slice(0, styleEdit.offset) +
        styleEdit.replacementText +
        currentContent.slice(styleEdit.offset + styleEdit.originalText.length);

      log.push(`Injected rule for .${m.className} into <style id="${STYLE_ID}">`);
    }

    return {
      changed: patches.length > 0,
      newContent: currentContent,
      patches,
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

/**
 * Returns true when `boundingBox` is present and indicates a 24x24 bump
 * leaves the element within its available area. Required fields:
 * `width`, `height`, `availableWidth`, `availableHeight`. Missing
 * boundingBox -> false (safe-tier declines rather than guesses).
 */
function hasRoomForBump(bb) {
  if (!bb || typeof bb !== 'object') return false;
  const { width, height, availableWidth, availableHeight } = bb;
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    typeof availableWidth !== 'number' ||
    typeof availableHeight !== 'number'
  ) {
    return false;
  }
  // Defensive: the bump raises the element to at least 24 in each axis. We
  // require enough room in the parent to fit a 24px target without
  // overlapping siblings.
  const targetW = Math.max(24, width);
  const targetH = Math.max(24, height);
  if (targetW > availableWidth) return false;
  if (targetH > availableHeight) return false;
  return true;
}

/**
 * Mirror of the interactive-target selector list in
 * src/checks/2-5-8-target-size-minimum.js. `<a>` is interactive, `<input>`
 * only when type is button/submit/reset, and any element with an
 * appropriate role.
 */
function isInteractive(el, $) {
  if (el.type !== 'tag') return false;
  const tag = el.name;
  if (tag === 'input') {
    const t = ($(el).attr('type') || '').toLowerCase();
    return INTERACTIVE_INPUT_TYPES.has(t);
  }
  if (INTERACTIVE_TAGS.has(tag)) return true;
  const role = ($(el).attr('role') || '').toLowerCase();
  if (INTERACTIVE_ROLES.has(role)) return true;
  return false;
}

/**
 * Read `<prop>: NNNpx` from an inline style string. Returns the integer or
 * null when the property is absent. Padding-exception handling lives in the
 * check, not the fixer; the fixer only acts when the violation supplies a
 * boundingBox confirming the bump is safe.
 */
function readPx(style, prop) {
  const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*(\\d+)px`, 'i');
  const m = style.match(re);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Stable hash of (tag + serialized attrs + position-index). Used to derive
 * a class name that is unique across runs and across multiple violations
 * within one file. SHA-256 is overkill but the codebase already uses it
 * elsewhere and the truncation to 8 hex chars matches associate-form-label.
 */
function generateClassName(el, $, posIndex) {
  const tag = el.name;
  const attrs = el.attribs || {};
  const serializedAttrs = Object.keys(attrs)
    .sort()
    .map((k) => `${k}=${attrs[k]}`)
    .join('|');
  const hash = crypto
    .createHash('sha256')
    .update(`${tag}|${serializedAttrs}|${posIndex}`)
    .digest('hex')
    .slice(0, 8);
  return `${CLASS_PREFIX}${hash}`;
}

/**
 * Return the original open-tag text with a class added. If `class=` already
 * exists, append the new class name. Otherwise insert a fresh class
 * attribute immediately before the closing `>`.
 */
function injectClassAttribute(tag, className) {
  const classRe = /(\sclass\s*=\s*)(["'])([^"']*)\2/i;
  if (classRe.test(tag)) {
    return tag.replace(classRe, (_m, lead, q, val) => {
      const trimmed = val.trim();
      const next = trimmed.length === 0 ? className : `${trimmed} ${className}`;
      return `${lead}${q}${next}${q}`;
    });
  }
  return tag.replace(/\s*\/?>$/, (m) => ` class="${className}"${m}`);
}

/**
 * Compute the offset/originalText/replacementText for the style-block edit
 * against `content`. Three cases:
 *   1. <style id="prism-target-size"> already contains rules: append the new
 *      rule before its closing </style>.
 *   2. <style id="prism-target-size"> exists but is empty: same as (1).
 *   3. The style block doesn't exist: create it immediately before </head>.
 *
 * Returns null when the file has no <head> at all (degenerate input).
 */
function computeStyleEdit(content, ruleText) {
  const blockRe = new RegExp(
    `<style\\b[^>]*\\bid\\s*=\\s*["']${STYLE_ID}["'][^>]*>([\\s\\S]*?)</style>`,
    'i'
  );
  const blockMatch = content.match(blockRe);
  if (blockMatch) {
    const blockStart = blockMatch.index;
    const blockText = blockMatch[0];
    // Locate </style> within the block to pick the insert point.
    const closeIdxLocal = blockText.toLowerCase().lastIndexOf('</style>');
    if (closeIdxLocal === -1) return null;
    const insertOffset = blockStart + closeIdxLocal;
    // Pull whatever indentation precedes </style> for tidiness; otherwise
    // a single newline.
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

  // Block doesn't exist — create one before </head>.
  const headCloseRe = /<\/head\s*>/i;
  const headMatch = content.match(headCloseRe);
  if (!headMatch) return null;
  const insertOffset = headMatch.index;
  // Match the existing line's indentation for the new <style> block.
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
