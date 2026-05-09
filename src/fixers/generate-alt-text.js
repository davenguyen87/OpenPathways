/**
 * Generate alt text for content images using LLM assistance.
 * Claims 1.1.1 violations on content-bearing <img> elements where surrounding
 * context is rich enough to ground a generation. Decorative images are left
 * entirely to add-alt-decorative (safe tier).
 */

const { buildPatch, revertPatch, applyMods } = require('../rebuild/types');
const { generateAssistedSuggestion } = require('../lib/llm-provenance');

const FIXER_ID = 'generate-alt-text';
const CRITERION = '1.1.1';

// Generic filename stems that carry no useful signal for alt generation.
const GENERIC_STEM_RE = /^(image|img|photo|picture|pic|untitled|unnamed|asset|file|tmp|temp|scan|screenshot|capture|frame|slide|banner|background|bg|header|footer|icon|logo|graphic|figure|fig)\d*$/i;

// Phrases that indicate a decorative pattern — safe-tier already owns these.
const DECORATIVE_PATTERN_RE = /spacer|divider|bullet|pixel|blank|transparent|icon-small|decoration/i;

// Alt validation rejections per PRD § "generate-alt-text.js — 1.1.1".
const FORBIDDEN_PREFIXES = ['image of', 'picture of', 'photo of'];

/**
 * Extract the filename stem from a src attribute value.
 *
 * @param {string} src
 * @returns {string}
 */
function stemFromSrc(src) {
  const base = src.split('/').pop().split('?')[0];
  const dot = base.lastIndexOf('.');
  return dot === -1 ? base : base.slice(0, dot);
}

/**
 * Return true when the src stem carries enough signal to ground a generation.
 * Rejects generic stems like "image1", "untitled", "asset2".
 *
 * @param {string} src
 * @returns {boolean}
 */
function hasMeaningfulStem(src) {
  if (!src) return false;
  const stem = stemFromSrc(src);
  return stem.length > 0 && !GENERIC_STEM_RE.test(stem);
}

/**
 * Extract plain text surrounding a match offset within `content`.
 * Returns up to `radius` chars on each side, stripped of HTML tags.
 *
 * @param {string} content
 * @param {number} offset
 * @param {number} radius
 * @returns {string}
 */
function surroundingText(content, offset, radius) {
  const start = Math.max(0, offset - radius);
  const end = Math.min(content.length, offset + radius);
  return content.slice(start, end).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Extract all existing alt text values from the HTML (for redundancy check).
 *
 * @param {string} content
 * @returns {string[]}
 */
function collectSiblingAlts(content) {
  const alts = [];
  const re = /<img\b[^>]*\balt\s*=\s*(?:"([^"]*?)"|'([^']*?)'|([^\s>]+))[^>]*>/gi;
  let m;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(content)) !== null) {
    const text = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (text) alts.push(text);
  }
  return alts;
}

/**
 * Extract the page title from the HTML.
 *
 * @param {string} content
 * @returns {string}
 */
function extractTitle(content) {
  const m = content.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? m[1].trim() : '';
}

/**
 * Validate alt text returned by the LLM.
 * Returns a rejection reason string, or null when the text is acceptable.
 *
 * @param {string} text
 * @param {string[]} siblingAlts
 * @returns {string|null}
 */
function validateAlt(text, siblingAlts) {
  if (!text || text.trim().length === 0) return 'LLM returned empty alt text';
  if (text.length > 250) return `alt text too long (${text.length} chars; max 250)`;
  if (/[\r\n]/.test(text)) return 'alt text contains line breaks';
  const lower = text.toLowerCase();
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (lower.startsWith(prefix)) return `alt text starts with forbidden phrase "${prefix}"`;
  }
  if (siblingAlts.some(s => s === text)) return 'alt text is byte-identical to a sibling alt';
  return null;
}

// ---------------------------------------------------------------------------
// Module export
// ---------------------------------------------------------------------------

module.exports = {
  id: FIXER_ID,
  name: 'Generate alt text for content images (LLM-assisted)',
  supported: ['scorm12', 'scorm2004', 'aicc'],
  confidence: 'needs-review',
  criterion: CRITERION,
  triage: 'auto-fix assisted',
  tier: 'assisted',
  provenance: 'llm',

  canFix(file, violation) {
    if (violation === null || violation === undefined) return false;
    if (violation.criterion !== CRITERION) return false;
    if (!file.isHtml) return false;

    const msg = violation.message || '';
    const snippet = violation.snippet || '';
    const combined = `${msg}|${snippet}`.toLowerCase();

    // Leave role=presentation and decorative-pattern images to add-alt-decorative.
    if (/role\s*=\s*["']?presentation["']?/i.test(combined)) return false;
    if (DECORATIVE_PATTERN_RE.test(combined)) return false;

    // Must be a missing-alt violation (not an empty-alt that's already set).
    // Common violation message patterns from axe-core / our checks:
    //   "Images must have alternate text"
    //   "img element missing alt attribute"
    //   "Missing required attribute: alt"
    if (!/missing|must have alternate|must have alt|no alt/i.test(msg)) return false;

    // Require a non-generic src so the LLM has some signal.
    const srcMatch = snippet.match(/\bsrc\s*=\s*(?:"([^"]+)"|'([^']+?)'|([^\s>]+))/i);
    const src = srcMatch ? (srcMatch[1] ?? srcMatch[2] ?? srcMatch[3] ?? '') : '';
    if (!hasMeaningfulStem(src)) return false;

    return true;
  },

  async apply(file, violations, context) {
    const log = [];
    const patches = [];
    const deferred = [];
    const original = file.content;
    const usedOffsets = new Set();
    const mods = [];

    // Pull provider from context; fall back to options-based construction inside
    // generateAssistedSuggestion when context is absent or incomplete.
    const opts = (context && context.options) || {};
    const provider = (context && context.provider) || undefined;

    const siblingAlts = collectSiblingAlts(original);
    const pageTitle = extractTitle(original);

    // Helper: push a deferred entry so the orchestrator surfaces the
    // violation rather than silently losing it. Called when the LLM is off,
    // the call fails, or the output validator rejects the suggestion.
    const defer = (violation, reason) => {
      deferred.push({
        criterion: violation.criterion || CRITERION,
        triage: 'auto-fix assisted',
        reason,
        file: file.path,
        line: typeof violation.line === 'number' ? violation.line : 0
      });
    };

    for (const violation of violations) {
      let patched = false;
      const snippet = violation.snippet || '';

      // Locate the matching <img> tag.
      const imgRegex = /<img\s+([^>]*?)>/gi;
      let match;
      let found = false;

      // eslint-disable-next-line no-cond-assign
      while ((match = imgRegex.exec(original)) !== null) {
        if (usedOffsets.has(match.index)) continue;
        const fullTag = match[0];
        const attrs = match[1];

        // Skip if already has alt.
        if (/\balt\s*=/i.test(attrs)) continue;

        // Skip decorative patterns — safe-tier owns these.
        if (/role\s*=\s*["']presentation["']/i.test(attrs)) continue;
        if (DECORATIVE_PATTERN_RE.test(attrs)) continue;

        // Match against the violation's snippet (first 50 chars is sufficient).
        const snippetHead = snippet.length > 0 ? snippet.substring(0, 50) : null;
        const matched = snippetHead
          ? fullTag.includes(snippetHead) || snippet.includes(fullTag.substring(0, 50))
          : false;

        if (!matched && snippet.length > 0) continue;

        // Extract src for filename context.
        const srcMatch = attrs.match(/\bsrc\s*=\s*(?:"([^"]+)"|'([^']+?)'|([^\s>]+))/i);
        const src = srcMatch ? (srcMatch[1] ?? srcMatch[2] ?? srcMatch[3] ?? '') : '';

        if (!hasMeaningfulStem(src)) {
          log.push(`Skipping <img> at offset ${match.index}: generic or empty filename`);
          continue;
        }

        // Gather surrounding context.
        const context400 = surroundingText(original, match.index, 200);

        // Build prompts per PRD.
        const systemPrompt = [
          'You are an accessibility consultant writing alt text for a content image in an e-learning module.',
          'Rules:',
          '- Write exactly one short, descriptive phrase. No sentence fragments, no trailing punctuation unless the description is a sentence.',
          '- Maximum 125 characters.',
          '- Do NOT start with "Image of", "Picture of", or "Photo of".',
          '- Do NOT repeat a caption that already describes the image.',
          '- Use plain language. Avoid jargon.',
          '- Output ONLY the alt text string — no quotes, no labels, no explanation.'
        ].join('\n');

        const siblingAltBlock = siblingAlts.length > 0
          ? `Sibling image alt texts (do not duplicate):\n${siblingAlts.map(a => `- "${a}"`).join('\n')}`
          : 'No sibling image alt texts.';

        const userPrompt = [
          `Page title: ${pageTitle || '(none)'}`,
          `Image filename: ${src.split('/').pop()}`,
          `Surrounding text (400-char window):\n${context400}`,
          siblingAltBlock,
          '',
          'Write the alt text for this image:'
        ].join('\n');

        const suggestion = await generateAssistedSuggestion({
          systemPrompt,
          userPrompt,
          options: opts,
          provider
        });

        if (!suggestion.ok) {
          log.push(`Could not generate alt for <img> at offset ${match.index}: ${suggestion.reason}`);
          defer(violation, suggestion.reason);
          found = true; // We located the tag; generation just failed.
          break;
        }

        const altText = suggestion.text.trim();
        const rejection = validateAlt(altText, siblingAlts);

        if (rejection) {
          log.push(`Alt validation failed for <img> at offset ${match.index}: ${rejection}`);
          defer(violation, `LLM output rejected: ${rejection}`);
          found = true;
          break;
        }

        // Escape double-quotes inside the generated text.
        const safeAlt = altText.replace(/"/g, '&quot;');
        const newTag = fullTag.replace(/\s*\/?>\s*$/, ` alt="${safeAlt}" />`);

        patches.push(
          buildPatch({
            fixer: FIXER_ID,
            criterion: CRITERION,
            triage: 'auto-fix assisted',
            tier: 'assisted',
            confidence: 'needs-review',
            provenanceSource: 'llm',
            provenanceExtras: suggestion.provenance,
            file: file.path,
            content: original,
            originalOffset: match.index,
            originalText: fullTag,
            replacementText: newTag,
            rationale: `LLM-generated alt text based on filename "${src.split('/').pop()}" and surrounding page context. Needs consultant review before sign-off.`
          })
        );
        mods.push({ offset: match.index, originalText: fullTag, replacementText: newTag });
        usedOffsets.add(match.index);
        // Track this new alt to avoid duplicates for subsequent violations.
        siblingAlts.push(altText);
        log.push(`Generated alt="${altText}" for <img> at offset ${match.index}`);
        patched = true;
        found = true;
        break;
      }

      if (!found) {
        log.push(`Could not locate matching <img> for violation at line ${violation.line}`);
        defer(violation, 'no matching <img> found in file');
      }
      void patched; // tracked for future per-violation diagnostics
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
