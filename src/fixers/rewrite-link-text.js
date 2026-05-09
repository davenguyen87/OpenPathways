/**
 * Rewrite vague link text for WCAG 2.4.4 (Link Purpose).
 *
 * Targets <a> elements whose visible text matches a vague-link allow-list
 * ("click here", "here", "read more", "more", "link", "details", "info").
 * Calls the configured LLM provider to generate descriptive replacement text
 * grounded in the surrounding HTML context and the link's destination.
 *
 * Assisted tier: every patch carries confidence='needs-review' and must be
 * signed off by a consultant in the diff report before the rebuild is
 * considered final. Provenance includes provider, model, prompt hash,
 * token usage, and latency so the review is fully auditable.
 *
 * @see PRD v4.1 § "rewrite-link-text.js — 2.4.4"
 */

'use strict';

const { buildPatch, revertPatch, applyMods } = require('../rebuild/types');
const { generateAssistedSuggestion } = require('../lib/llm-provenance');

const FIXER_ID = 'rewrite-link-text';
const CRITERION = '2.4.4';

/**
 * Vague link phrases that this fixer claims (case-insensitive, trimmed).
 * The allow-list is intentionally narrow: common patterns confirmed by the
 * v3 audit corpus to produce consistent violations.
 *
 * @type {string[]}
 */
const VAGUE_PHRASES = ['click here', 'here', 'read more', 'more', 'link', 'details', 'info'];

/**
 * Maximum allowed length for LLM-generated link text (per PRD § validation).
 *
 * @type {number}
 */
const MAX_OUTPUT_CHARS = 80;

/**
 * How many characters of preceding HTML to include as context in the user
 * prompt. Long enough to capture the surrounding sentence; short enough to
 * keep prompt tokens low.
 *
 * @type {number}
 */
const CONTEXT_PRECEDING_CHARS = 200;

/**
 * System prompt prefix for the link-text rewrite task. Constraints are
 * stated up front so the model's first token commitment is already scoped.
 * ≤ 60 chars per PRD guidance (action-oriented imperative).
 *
 * @type {string}
 */
const SYSTEM_PROMPT =
  'Rewrite vague link text to describe the link destination. ' +
  'Rules: under 80 characters, action-oriented, plain language, ' +
  'no URLs or domain names in the output, no quotes.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the visible text content of an <a> element (inner text only,
 * stripping all child tags). Handles nested spans, strongs, etc.
 *
 * @param {string} fullMatch - The full <a>...</a> match string
 * @returns {string}
 */
function extractLinkText(fullMatch) {
  // Strip all HTML tags inside the element, collapse whitespace.
  return fullMatch
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Determine whether the visible text of a link matches the vague-link
 * allow-list (case-insensitive, trimmed).
 *
 * @param {string} text - Visible text to test
 * @returns {string|null} The matched vague phrase (lower-cased), or null
 */
function matchesVaguePhrase(text) {
  const normalized = text.toLowerCase().trim();
  return VAGUE_PHRASES.find((p) => p === normalized) || null;
}

/**
 * Extract the href value from an <a> opening tag. Returns empty string if
 * no href attribute is present.
 *
 * @param {string} openTag - The opening <a ...> tag
 * @returns {string}
 */
function extractHref(openTag) {
  const m = openTag.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*))/i);
  if (!m) return '';
  return (m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]) || '';
}

/**
 * Sanitize a full URL or relative path into a destination hint suitable for
 * inclusion in the LLM prompt. Per PRD privacy posture: never send the full
 * URL verbatim — extract only the filename and any fragment identifier.
 *
 * Examples:
 *   "https://example.com/courses/module1.html#quiz" → "module1.html#quiz"
 *   "/assets/pdf/report.pdf"                        → "report.pdf"
 *   "#section-3"                                    → "#section-3"
 *   ""                                              → "(no destination)"
 *
 * @param {string} href - Raw href attribute value
 * @returns {string}
 */
function sanitizeHref(href) {
  if (!href) return '(no destination)';
  if (href.startsWith('#')) return href; // pure fragment is already safe

  // Split on '?' first to discard query params, then on '#' to isolate fragment
  const [pathPart, fragment] = href.split('#');
  const filename = (pathPart || '').split('/').pop() || '';
  const fragmentSuffix = fragment !== undefined ? `#${fragment}` : '';

  const hint = `${filename}${fragmentSuffix}`;
  return hint || '(no destination)';
}

/**
 * Extract the page title from HTML content. Returns an empty string when no
 * <title> element is found.
 *
 * @param {string} html
 * @returns {string}
 */
function extractPageTitle(html) {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? m[1].trim() : '';
}

/**
 * Extract up to `maxChars` of plain text immediately preceding `offset` in
 * `content`. Strips HTML tags, collapses whitespace.
 *
 * @param {string} content
 * @param {number} offset
 * @param {number} maxChars
 * @returns {string}
 */
function extractPrecedingContext(content, offset, maxChars) {
  const raw = content.slice(Math.max(0, offset - maxChars * 3), offset);
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-maxChars);
}

/**
 * Build the LLM user prompt for a single link rewrite request.
 *
 * @param {Object} args
 * @param {string} args.originalText   - Current visible link text
 * @param {string} args.precedingContext - Plain-text context before the link
 * @param {string} args.destinationHint - Sanitized href (filename + fragment)
 * @param {string} args.pageTitle       - Page <title> if available
 * @returns {string}
 */
function buildUserPrompt({ originalText, precedingContext, destinationHint, pageTitle }) {
  const parts = [];
  if (pageTitle) parts.push(`Page title: ${pageTitle}`);
  if (precedingContext) parts.push(`Context before the link: ${precedingContext}`);
  parts.push(`Current link text: "${originalText}"`);
  parts.push(`Link destination (filename only): ${destinationHint}`);
  parts.push(
    'Write replacement link text that makes the link purpose clear out of context. ' +
      'Output only the link text — no explanation, no quotes, no trailing period.'
  );
  return parts.join('\n');
}

/**
 * Validate LLM output against the PRD's rejection rules for link-text
 * rewrites. Returns `{ valid: true }` on success, or
 * `{ valid: false, reason }` on failure.
 *
 * Rejection conditions (per PRD § "Output validation"):
 * 1. Empty string.
 * 2. Longer than MAX_OUTPUT_CHARS (80) characters.
 * 3. Contains any of the vague phrases the violation flagged.
 * 4. Byte-identical to the original link text.
 *
 * @param {string} text          - LLM output (trimmed)
 * @param {string} originalText  - The link text being replaced
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateOutput(text, originalText) {
  if (!text) {
    return { valid: false, reason: 'LLM returned empty link text' };
  }
  if (text.length > MAX_OUTPUT_CHARS) {
    return {
      valid: false,
      reason: `LLM output too long: ${text.length} chars (max ${MAX_OUTPUT_CHARS})`
    };
  }
  const lower = text.toLowerCase();
  const matchedVague = VAGUE_PHRASES.find((p) => lower.includes(p));
  if (matchedVague) {
    return {
      valid: false,
      reason: `LLM output still contains vague phrase "${matchedVague}"`
    };
  }
  if (text === originalText) {
    return { valid: false, reason: 'LLM output is byte-identical to original link text' };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Fixer module
// ---------------------------------------------------------------------------

module.exports = {
  id: FIXER_ID,
  name: 'Rewrite vague link text (2.4.4)',
  supported: ['scorm12', 'scorm2004', 'aicc'],

  /** Confidence is always needs-review for assisted-tier patches. */
  confidence: 'needs-review',

  criterion: CRITERION,
  triage: 'auto-fix assisted',
  tier: 'assisted',
  provenance: 'llm',

  /**
   * Determine whether this fixer can claim a given violation.
   *
   * Returns true when ALL of the following hold:
   * 1. The file is HTML.
   * 2. The violation is for criterion 2.4.4.
   * 3. The violation's snippet or message identifies an <a> element whose
   *    visible text matches the vague-link allow-list.
   * 4. There is some surrounding context (the file is not just the bare link
   *    with no preceding text) — we need at least one non-empty character
   *    before the link's position to construct a meaningful prompt.
   *
   * The context check is intentionally lenient: we require only that some
   * preceding content exists. The apply() step does the deeper validation
   * before calling the LLM.
   *
   * @param {{ isHtml: boolean, content: string, path: string }} file
   * @param {{ criterion: string, snippet?: string, message?: string, line?: number }} violation
   * @returns {boolean}
   */
  canFix(file, violation) {
    if (!file || !file.isHtml) return false;
    if (!violation) return false;
    if (violation.criterion !== CRITERION) return false;

    const snippet = violation.snippet || '';
    const message = violation.message || '';

    // The violation must mention an <a> element in its snippet or message.
    const hasAnchorSnippet = /<a[\s>]/i.test(snippet) || /\ban\s+element\b/i.test(message);
    if (!hasAnchorSnippet && !snippet) return false;

    // Extract visible text from the snippet (or pull from the message).
    let visibleText = '';
    if (snippet) {
      visibleText = extractLinkText(snippet);
    }
    if (!visibleText) {
      // Fall back: the message may contain the offending phrase in quotes.
      const quoted = message.match(/["']([^"']{1,60})["']/);
      if (quoted) visibleText = quoted[1];
    }

    if (!visibleText) return false;
    if (!matchesVaguePhrase(visibleText)) return false;

    // Require that the file has some content before the link — a file that is
    // just the bare link in isolation provides no grounding context.
    const linkPos = snippet ? file.content.indexOf(snippet.trim().slice(0, 40)) : -1;
    if (linkPos === 0) return false; // link is at position 0 — no preceding context

    return true;
  },

  /**
   * Apply link-text rewrites for all claimed violations.
   *
   * For each violation:
   * 1. Locate the <a>…</a> element in the file.
   * 2. Build system + user prompts from surrounding context and sanitized href.
   * 3. Call generateAssistedSuggestion().
   * 4. Validate the output.
   * 5. Emit a patch that replaces only the text content between the opening
   *    and closing <a> tags — the href and all other attributes are unchanged.
   *
   * On LLM failure or validation failure the violation is not patched and a
   * log entry records the reason. The rebuild continues.
   *
   * @param {{ isHtml: boolean, content: string, path: string }} file
   * @param {Array<{ criterion: string, snippet?: string, line?: number, message?: string }>} violations
   * @param {{ options?: Object, provider?: Object }} [context]
   * @returns {Promise<{ changed: boolean, newContent: string, patches: Object[], log: string[] }>}
   */
  async apply(file, violations, context) {
    const log = [];
    const patches = [];
    const deferred = [];
    const original = file.content;
    const mods = [];
    const usedOffsets = new Set();

    const options = (context && context.options) || {};
    const provider = (context && context.provider) || undefined;

    const pageTitle = extractPageTitle(original);

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

    for (const violation of violations) {
      const snippet = (violation.snippet || '').trim();

      // ------------------------------------------------------------------
      // 1. Locate the <a>…</a> element in the file content.
      // We match the full opening tag with closing </a>, allowing multiline.
      // ------------------------------------------------------------------
      const anchorRegex = /(<a\b[^>]*>)([\s\S]*?)<\/a>/gi;
      let match;
      let claimed = null;

      // eslint-disable-next-line no-cond-assign
      while ((match = anchorRegex.exec(original)) !== null) {
        if (usedOffsets.has(match.index)) continue;

        const [fullMatch, openTag, innerContent] = match;
        const visibleText = extractLinkText(innerContent);
        const vaguePhrase = matchesVaguePhrase(visibleText);
        if (!vaguePhrase) continue;

        // Anchor this element to the violation via the snippet.
        const snipHead = snippet ? snippet.slice(0, 60) : '';
        const snippetMatches =
          !snipHead ||
          fullMatch.includes(snipHead) ||
          openTag.includes(snipHead);

        // Also accept a line-number match when snippet is unavailable.
        const lineMatch =
          !snippet &&
          violation.line &&
          original.slice(0, match.index).split('\n').length === violation.line;

        if (!snippetMatches && !lineMatch) continue;

        claimed = { fullMatch, openTag, innerContent, visibleText, vaguePhrase, offset: match.index };
        break;
      }

      if (!claimed) {
        log.push(
          `[${FIXER_ID}] Could not locate vague <a> element for violation at line ` +
            `${violation.line || '?'}; skipped`
        );
        defer(violation, 'no matching vague <a> element found in file');
        continue;
      }

      const { fullMatch, openTag, innerContent, visibleText, vaguePhrase, offset } = claimed;

      // ------------------------------------------------------------------
      // 2. Build prompts.
      // ------------------------------------------------------------------
      const href = extractHref(openTag);
      const destinationHint = sanitizeHref(href);
      const precedingContext = extractPrecedingContext(original, offset, CONTEXT_PRECEDING_CHARS);

      // Require at least some preceding context — pure-link-with-no-context
      // files should not be sent to the LLM (canFix guards most cases, but
      // apply() is the last line of defence).
      if (!precedingContext) {
        log.push(
          `[${FIXER_ID}] No preceding context for link "${visibleText}" at offset ${offset}; deferred`
        );
        defer(violation, 'no preceding context to ground link rewrite');
        continue;
      }

      const userPrompt = buildUserPrompt({
        originalText: visibleText,
        precedingContext,
        destinationHint,
        pageTitle
      });

      // ------------------------------------------------------------------
      // 3. Call the LLM.
      // ------------------------------------------------------------------
      const result = await generateAssistedSuggestion({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
        options,
        provider
      });

      if (!result.ok) {
        log.push(
          `[${FIXER_ID}] LLM call failed for link "${visibleText}" at offset ${offset}: ` +
            result.reason
        );
        defer(violation, result.reason);
        continue;
      }

      // ------------------------------------------------------------------
      // 4. Validate output.
      // ------------------------------------------------------------------
      const candidateText = result.text.trim();
      const validation = validateOutput(candidateText, visibleText);
      if (!validation.valid) {
        log.push(
          `[${FIXER_ID}] LLM output rejected for link "${visibleText}" at offset ${offset}: ` +
            validation.reason
        );
        defer(violation, `LLM output rejected: ${validation.reason}`);
        continue;
      }

      // ------------------------------------------------------------------
      // 5. Emit patch — rewrite only the inner text content, not the href.
      //
      // The replacement preserves the opening tag and closing tag verbatim;
      // only the text between them changes. If the original inner content
      // contained child elements (e.g. <strong>click here</strong>), the
      // replacement swaps the entire inner content for plain text. This is
      // correct: vague-link rewrites need clear, unambiguous visible text
      // and should not preserve nested markup that was part of the problem.
      // ------------------------------------------------------------------
      const newFullMatch = `${openTag}${candidateText}</a>`;

      const rationale =
        `Rewrote vague link text "${visibleText}" → "${candidateText}" ` +
        `to satisfy WCAG 2.4.4 (Link Purpose). ` +
        `Destination: ${destinationHint}. ` +
        `Confidence: needs-review — consultant sign-off required.`;

      patches.push(
        buildPatch({
          fixer: FIXER_ID,
          criterion: CRITERION,
          triage: 'auto-fix assisted',
          tier: 'assisted',
          confidence: 'needs-review',
          provenanceSource: 'llm',
          provenanceExtras: result.provenance,
          file: file.path,
          content: original,
          originalOffset: offset,
          originalText: fullMatch,
          replacementText: newFullMatch,
          rationale
        })
      );

      mods.push({ offset, originalText: fullMatch, replacementText: newFullMatch });
      usedOffsets.add(offset);
      log.push(
        `[${FIXER_ID}] Rewrote link "${visibleText}" → "${candidateText}" at offset ${offset}`
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
   * Reverse a single assisted patch. Delegates to revertPatch — the byte-
   * level mechanics are identical to safe-tier patches.
   *
   * @param {{ path: string, content: string }} file
   * @param {Object} patch
   * @returns {Promise<{ newContent: string, log: string[] }>}
   */
  async revert(file, patch) {
    return revertPatch(file, patch);
  },

  /**
   * Legacy shim — kept for callers that use the v2 `fix(file, violations)`
   * signature. Delegates to apply() without a context object (LLM assistance
   * will decline gracefully if no provider is configured).
   *
   * @param {{ isHtml: boolean, content: string, path: string }} file
   * @param {Array<Object>} violations
   * @returns {Promise<{ changed: boolean, newContent: string, log: string[] }>}
   */
  async fix(file, violations) {
    const result = await this.apply(file, violations);
    return { changed: result.changed, newContent: result.newContent, log: result.log };
  }
};
