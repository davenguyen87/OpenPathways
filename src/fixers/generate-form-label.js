/**
 * Generate a <label> for form controls with no label material at all.
 *
 * Assisted-tier companion to the safe-tier `associate-form-label` fixer.
 * `associate-form-label` handles controls that already have a nearby <label>
 * element — it just adds the for/id wiring. This fixer handles the harder
 * case: the control has no <label> in its block at all, no aria-label, no
 * aria-labelledby, and no adjacent text node close enough for the safe-tier
 * fixer to pair. We ask the LLM to generate one.
 *
 * WCAG 3.3.2 (Labels or Instructions).
 */

'use strict';

const crypto = require('crypto');
const cheerio = require('cheerio');
const { buildPatch, revertPatch, applyMods } = require('../rebuild/types');
const { generateAssistedSuggestion } = require('../lib/llm-provenance');

const FIXER_ID = 'generate-form-label';
const CRITERION = '3.3.2';
const ID_PREFIX = 'prism-label-';

// Same block tags the safe-tier fixer uses for its unambiguity scan.
const BLOCK_TAGS = new Set([
  'p', 'div', 'li', 'td', 'th', 'fieldset',
  'form', 'section', 'article', 'header', 'footer',
  'main', 'aside', 'body'
]);

// Input types that don't need a visible label (non-interactive / implicit).
const SKIP_TYPES = new Set(['hidden', 'submit', 'reset', 'button', 'image']);

// Verb-phrase fragments that signal the LLM produced an instruction, not a
// noun-phrase label. Per PRD: instructions are 3.3.5, not 3.3.2.
const VERB_PHRASE_RE = /\b(enter|type|choose|select|pick|provide|fill|input|specify)\b/i;

module.exports = {
  id: FIXER_ID,
  name: 'Generate <label> for unlabelled form control',
  supported: ['scorm12', 'scorm2004', 'aicc'],
  confidence: 'needs-review',
  criterion: CRITERION,
  triage: 'auto-fix assisted',
  tier: 'assisted',
  provenance: 'llm',

  /**
   * Claim a violation only when there is NO label material the safe-tier
   * fixer could use:
   *   - no <label> element anywhere in the control's nearest block ancestor
   *   - no aria-label / aria-labelledby on the control
   *   - not a non-interactive input type (hidden / submit / reset / button / image)
   *
   * `associate-form-label` already has first pick: if there is a bare <label>
   * in the block (even un-paired), that fixer should handle it. We only claim
   * when there is no label text at all to pair.
   *
   * @param {{ isHtml: boolean, content: string, path: string }} file
   * @param {{ criterion: string, snippet?: string, message?: string }} violation
   * @returns {boolean}
   */
  canFix(file, violation) {
    if (!file || !file.isHtml) return false;
    if (!violation) return false;
    if (violation.criterion !== CRITERION) return false;

    const snippet = violation.snippet || '';
    const lower = snippet.toLowerCase();

    // Skip non-interactive input types — they never need a label.
    if (/<input[^>]+type\s*=\s*["']?(hidden|submit|reset|button|image)["']?/i.test(snippet)) {
      return false;
    }

    // If there's already an aria-label or aria-labelledby, no work needed.
    if (/aria-label(ledby)?\s*=/i.test(lower)) return false;

    // If there's a <label> element anywhere visible in the snippet, the
    // safe-tier associate-form-label fixer should claim this — defer to it.
    if (/<label[\s>]/i.test(snippet)) return false;

    // Snippet must describe an input, select, or textarea.
    if (!/<(input|select|textarea)[\s>]/i.test(snippet)) return false;

    return true;
  },

  /**
   * For each violation: locate the control in the HTML, gather context
   * (attributes, fieldset/legend, page heading), call the LLM, validate,
   * and emit a single patch that:
   *   1. Inserts `<label for="<id>">text</label>` immediately before the control.
   *   2. Injects `id="<id>"` into the control's open tag (if absent).
   * Both edits are encoded in one patch via a span that covers the original
   * control tag and the empty string immediately before it.
   *
   * @param {{ isHtml: boolean, content: string, path: string }} file
   * @param {Array<{ criterion: string, snippet?: string, line?: number }>} violations
   * @param {{ options?: Object }} [context]
   * @returns {Promise<{ changed: boolean, newContent: string, patches: Array, log: string[] }>}
   */
  async apply(file, violations, context) {
    const options = (context && context.options) || {};
    const provider = (context && context.provider) || undefined;
    const original = file.content;
    const log = [];
    const patches = [];
    const deferred = [];
    const mods = [];
    const usedOffsets = new Set();

    // Helper: surface a per-violation defer reason so the orchestrator can
    // record it instead of silently swallowing the violation when the LLM
    // is off, the call fails, or the output validator rejects.
    const defer = (violation, reason) => {
      deferred.push({
        criterion: violation.criterion || CRITERION,
        triage: 'auto-fix assisted',
        reason,
        file: file.path,
        line: typeof violation.line === 'number' ? violation.line : 0
      });
    };

    if (!file.isHtml) {
      return { changed: false, newContent: original, patches, deferred, log };
    }

    const $ = cheerio.load(original, {
      decodeEntities: false,
      sourceCodeLocationInfo: true
    });

    // Collect page heading text for the user prompt (first h1/h2/h3).
    const pageHeading = $('h1, h2, h3').first().text().trim().slice(0, 100);

    for (const violation of violations) {
      const snippet = violation.snippet || '';
      if (!snippet) {
        log.push(`[${FIXER_ID}] no snippet for violation at line ${violation.line}; skipped`);
        continue;
      }

      // Locate the matching control element.
      const controlEl = findControlElement($, original, snippet, usedOffsets);
      if (!controlEl) {
        log.push(`[${FIXER_ID}] could not locate control matching snippet at line ${violation.line}; skipped`);
        continue;
      }

      const $el = $(controlEl);
      const tagName = controlEl.tagName.toLowerCase();

      // Double-check: skip non-interactive types at the element level.
      if (tagName === 'input') {
        const t = ($el.attr('type') || 'text').toLowerCase();
        if (SKIP_TYPES.has(t)) {
          log.push(`[${FIXER_ID}] skipping <input type="${t}"> (non-interactive)`);
          continue;
        }
      }

      // Skip if the element already has an aria-label / aria-labelledby.
      if ($el.attr('aria-label') || $el.attr('aria-labelledby')) {
        log.push(`[${FIXER_ID}] control already has ARIA labelling; skipped`);
        continue;
      }

      // Check the nearest block ancestor for any <label> — if one exists,
      // the safe-tier fixer should have claimed this. We skip to be safe.
      const block = closestBlock(controlEl);
      if (block && $(block).find('label').length > 0) {
        log.push(`[${FIXER_ID}] found <label> in block ancestor; deferring to associate-form-label`);
        continue;
      }

      // Gather fieldset/legend text (if any).
      const fieldsetLegend = getFieldsetLegend($, controlEl);

      // Build sanitised attribute context for the prompt (never expose value=).
      const attrContext = buildAttrContext($el, tagName);

      // Build prompts per PRD § "generate-form-label.js — 3.3.2".
      const systemPrompt =
        'You write short, clear form field labels for web accessibility. ' +
        'Output a noun phrase of ≤ 40 characters. ' +
        'Do not use "Please enter", verbs, trailing colons, or instructional helper text. ' +
        'Output only the label text — no quotes, no explanation.';

      const userPromptParts = [
        `Form control: <${tagName} ${attrContext}>`,
        fieldsetLegend ? `Parent fieldset/legend: "${fieldsetLegend}"` : null,
        pageHeading ? `Page heading: "${pageHeading}"` : null
      ].filter(Boolean);

      const userPrompt = userPromptParts.join('\n');

      const suggestion = await generateAssistedSuggestion({
        systemPrompt,
        userPrompt,
        options,
        provider
      });

      if (!suggestion.ok) {
        log.push(`[${FIXER_ID}] LLM call failed for control at line ${violation.line}: ${suggestion.reason}`);
        defer(violation, suggestion.reason);
        continue;
      }

      const labelText = (suggestion.text || '').trim();

      // Validate per PRD output rules.
      const validationError = validateLabelText(labelText, $el.attr('placeholder'));
      if (validationError) {
        log.push(`[${FIXER_ID}] LLM output rejected at line ${violation.line}: ${validationError} — deferring`);
        defer(violation, `LLM output rejected: ${validationError}`);
        continue;
      }

      // Determine the source offset of the control's open tag.
      const loc = controlEl.sourceCodeLocation;
      if (!loc) {
        log.push(`[${FIXER_ID}] no source location for control at line ${violation.line}; skipped`);
        continue;
      }
      const tagStart = loc.startOffset;
      const tagEnd = (loc.startTag ? loc.startTag.endOffset : loc.endOffset);
      if (usedOffsets.has(tagStart)) {
        log.push(`[${FIXER_ID}] duplicate offset ${tagStart}; skipped`);
        continue;
      }

      // Generate a deterministic id from file path + offset.
      const existingId = $el.attr('id');
      const generatedId = existingId || generateId(file.path, tagStart);

      const controlTag = original.slice(tagStart, tagEnd);

      // Build the replacement: label insertion + optional id injection.
      const newControlTag = existingId
        ? controlTag
        : injectIdAttribute(controlTag, generatedId);
      const labelHtml = `<label for="${generatedId}">${escapeHtml(labelText)}</label>`;

      // The patch span covers from the insertion point (tagStart) through the
      // end of the control's open tag. originalText is just the control's open
      // tag; replacementText prepends the label. Both edits (label insert + id
      // injection) are encoded atomically in a single before/after pair.
      const originalText = controlTag;
      const replacementText = `${labelHtml}${newControlTag}`;

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
          originalOffset: tagStart,
          originalText,
          replacementText,
          rationale:
            `No <label> or ARIA labelling found. Generated label "${labelText}" ` +
            `via LLM (${(suggestion.provenance && suggestion.provenance.provider) || 'unknown'}). ` +
            `Requires consultant sign-off.`
        })
      );
      mods.push({ offset: tagStart, originalText, replacementText });
      usedOffsets.add(tagStart);
      log.push(
        `[${FIXER_ID}] inserted <label for="${generatedId}">${labelText}</label> ` +
        `before <${tagName}> at offset ${tagStart}`
      );
    }

    return {
      changed: patches.length > 0,
      newContent: applyMods(original, mods),
      patches,
      deferred,
      log
    };
  },

  /**
   * Revert a patch produced by this fixer. Because the patch's `before`/`after`
   * capture the full span (label element + control open tag), reverting removes
   * both the inserted <label> and the injected id atomically.
   *
   * @param {{ path: string, content: string }} file
   * @param {import('../rebuild/types').Patch} patch
   */
  async revert(file, patch) {
    return revertPatch(file, patch);
  },

  /** Legacy shim — v4 orchestrator may call fix() instead of apply(). */
  async fix(file, violations) {
    const result = await this.apply(file, violations);
    return { changed: result.changed, newContent: result.newContent, log: result.log };
  }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Walk up from `el` to find the nearest recognised block-level ancestor.
 *
 * @param {Object} el - Cheerio DOM node
 * @returns {Object|null}
 */
function closestBlock(el) {
  let cur = el.parent;
  while (cur && cur.type === 'tag') {
    if (BLOCK_TAGS.has(cur.tagName)) return cur;
    cur = cur.parent;
  }
  return null;
}

/**
 * Return the text content of the nearest <legend> inside a <fieldset>
 * ancestor, or an empty string if none.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @param {Object} el
 * @returns {string}
 */
function getFieldsetLegend($, el) {
  let cur = el.parent;
  while (cur && cur.type === 'tag') {
    if (cur.tagName === 'fieldset') {
      return $(cur).children('legend').first().text().trim().slice(0, 100);
    }
    cur = cur.parent;
  }
  return '';
}

/**
 * Build a sanitised attribute string for the LLM user prompt. Omits `value`
 * (may contain PII). Includes name, id, type, placeholder, required, and
 * any data-* attributes that look like labels.
 *
 * @param {import('cheerio').Cheerio} $el
 * @param {string} tagName
 * @returns {string}
 */
function buildAttrContext($el, tagName) {
  const keep = ['name', 'id', 'type', 'placeholder', 'required', 'autocomplete'];
  const parts = [];
  for (const attr of keep) {
    const val = $el.attr(attr);
    if (val !== undefined && val !== null && val !== '') {
      // placeholder is useful context but must not become the label verbatim.
      parts.push(`${attr}="${val}"`);
    }
  }
  // Include any data-label / data-field-label hints.
  const attribs = ($el[0] && $el[0].attribs) || {};
  for (const [k, v] of Object.entries(attribs)) {
    if (/^data-(label|field-?label|title)$/i.test(k) && v) {
      parts.push(`${k}="${v}"`);
    }
  }
  return parts.join(' ');
}

/**
 * Validate the LLM's label text per PRD rules.
 * Returns an error string if invalid, null if valid.
 *
 * @param {string} text
 * @param {string|undefined} placeholder
 * @returns {string|null}
 */
function validateLabelText(text, placeholder) {
  if (!text || text.length === 0) return 'empty output';
  if (text.length > 80) return `too long (${text.length} chars, max 80)`;
  if (placeholder && text.toLowerCase() === placeholder.toLowerCase()) {
    return 'equals placeholder verbatim';
  }
  if (VERB_PHRASE_RE.test(text)) return 'contains verb phrase (instructional text)';
  return null;
}

/**
 * Generate a deterministic element id from the file path and source offset.
 * Format: `prism-label-<sha8>`.
 *
 * @param {string} filePath
 * @param {number} offset
 * @returns {string}
 */
function generateId(filePath, offset) {
  const hash = crypto
    .createHash('sha256')
    .update(`${filePath}:${offset}`)
    .digest('hex')
    .slice(0, 8);
  return `${ID_PREFIX}${hash}`;
}

/**
 * Inject `id="<idValue>"` into an open tag that has no existing id attribute.
 * Inserts just before the closing `>` or `/>`.
 *
 * @param {string} tag
 * @param {string} idValue
 * @returns {string}
 */
function injectIdAttribute(tag, idValue) {
  return tag.replace(/\s*\/?>$/, (m) => ` id="${idValue}"${m}`);
}

/**
 * Minimal HTML escaping for label text content.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Find the first form control DOM element whose open tag contains the snippet
 * text and whose offset has not been used in this apply() run.
 *
 * Strategy: iterate over all input/select/textarea elements; for each, compare
 * the source open tag against the violation snippet. A 50-char prefix match is
 * sufficient to identify the element, mirroring add-alt-decorative's approach.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @param {string} original
 * @param {string} snippet
 * @param {Set<number>} usedOffsets
 * @returns {Object|null} Cheerio DOM node or null
 */
function findControlElement($, original, snippet, usedOffsets) {
  const controls = $('input, select, textarea').toArray();
  const snippetPrefix = snippet.slice(0, 60);

  for (const el of controls) {
    const loc = el.sourceCodeLocation;
    if (!loc) continue;
    const tagStart = loc.startOffset;
    if (usedOffsets.has(tagStart)) continue;

    const tagEnd = loc.startTag ? loc.startTag.endOffset : loc.endOffset;
    const openTag = original.slice(tagStart, tagEnd);

    // Match on a 60-char prefix of the snippet against the open tag.
    if (
      openTag.slice(0, 60).includes(snippetPrefix.slice(0, 30)) ||
      snippetPrefix.includes(openTag.slice(0, 30))
    ) {
      return el;
    }
  }
  return null;
}
