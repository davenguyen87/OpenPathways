/**
 * 2.4.4 Link Purpose (In Context)
 *
 * Flag <a> elements whose visible text matches a known vague-link allow-list
 * ("click here", "here", "read more", "more", "link", "details", "info").
 * These links fail WCAG 2.4.4 because their purpose cannot be determined from
 * the link text alone — screen reader users who navigate by links get a list
 * of meaningless "click here" entries with no context.
 *
 * Detection scope:
 *   - Static: flags vague link text in HTML source.
 *
 * Non-detections (out of scope for static analysis):
 *   - Links with aria-label / aria-labelledby that extend the visible text.
 *   - Links inside <figure> / <figcaption> programmatically associated context.
 *   These are covered by WCAG 2.4.4's "in context" allowance and require
 *   runtime evaluation; a dynamic complement can be added later.
 */

'use strict';

const { lineOf } = require('../lib/line-of');

/** Vague link phrases that fail 2.4.4 (lower-cased for comparison). */
const VAGUE_PHRASES = new Set([
  'click here',
  'here',
  'read more',
  'more',
  'link',
  'details',
  'info',
]);

/**
 * Extract the visible text of an <a> element from cheerio, stripping child
 * tags and collapsing whitespace. Same normalisation as the rewrite fixer uses
 * so canFix() and the audit detection are in sync.
 *
 * @param {import('cheerio').Cheerio} $el
 * @returns {string}
 */
function visibleText($el) {
  return $el.text().replace(/\s+/g, ' ').trim();
}

module.exports = {
  id: '2.4.4',
  name: 'Link purpose (in context)',
  level: 'A',
  wcagIntroduced: '2.0',
  url: 'https://www.w3.org/WAI/WCAG22/Understanding/link-purpose-in-context',

  async run(ctx) {
    const violations = [];

    for (const file of ctx.files.html) {
      const $ = file.$();

      $('a[href]').each((_i, el) => {
        const $el = $(el);

        // Skip if an aria-label provides an accessible name that overrides
        // the visible text — that name is presumed to be descriptive.
        if ($el.attr('aria-label') || $el.attr('aria-labelledby')) return;

        const text = visibleText($el);
        if (!text) return; // Empty-text links are a 4.1.2 issue, not 2.4.4.

        if (!VAGUE_PHRASES.has(text.toLowerCase())) return;

        // Build a short snippet showing the opening tag + text + closing tag.
        // outerHTML is the canonical match; the snippet helper extracts the
        // matching line from the file content so consumers (fixers, reports)
        // see surrounding markup.
        const outerHtml = $.html($el);
        const line = lineOf(file.content, outerHtml) || 1;

        violations.push({
          criterion: '2.4.4',
          file: file.path,
          line,
          column: null,
          // Trim/clip the outer HTML directly — assisted fixers parse this
          // for the anchor and visible text, so it must include `<a ...>...</a>`
          // verbatim, not the un-trimmed surrounding line.
          snippet: outerHtml.length > 200 ? outerHtml.slice(0, 200) : outerHtml,
          message:
            `Link text "${text}" is too vague to convey the link's purpose out of context. ` +
            `Screen reader users who navigate by links will hear "${text}" with no indication ` +
            `of where the link goes. Replace with descriptive text or add aria-label.`,
          severity: 'serious',
          confidence: 'definitive',
          source: 'static',
        });
      });
    }

    return violations;
  },
};
