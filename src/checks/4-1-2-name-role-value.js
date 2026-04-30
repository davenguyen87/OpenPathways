/**
 * 4.1.2 Name, role, value
 * Flag custom interactive elements missing role, aria-label/labelledby, or meaningful text.
 */

const { lineOf } = require('../lib/line-of');
const { snippet } = require('../lib/snippet');

const SEMANTIC_TAGS = new Set([
  'button',
  'a',
  'input',
  'select',
  'textarea',
  'summary',
  'details',
  'label',
  'form'
]);

module.exports = {
  id: '4.1.2',
  name: 'Name, role, value',
  level: 'A',
  wcagIntroduced: '2.0',
  url: 'https://www.w3.org/WAI/WCAG22/Understanding/name-role-value',

  async run(ctx) {
    const violations = [];
    const seen = new Set();

    for (const file of ctx.files.html) {
      const $ = file.$();

      $('*').each((i, el) => {
        const $el = $(el);
        const tag = el.name.toLowerCase();

        // Skip semantic interactive elements
        if (SEMANTIC_TAGS.has(tag)) return;

        // Check if element is interactive
        const onclick = $el.attr('onclick');
        const tabindex = $el.attr('tabindex');
        const isInteractive = !!onclick || typeof tabindex !== 'undefined';

        if (!isInteractive) return;

        // Check for role
        const role = $el.attr('role');
        const ariaLabel = $el.attr('aria-label');
        const ariaLabelledby = $el.attr('aria-labelledby');

        // Check for meaningful inner text
        const text = $el.text().trim();
        const hasMeaningfulText = text.length > 0 && !/^\s*$/.test(text);

        // Determine what's missing
        const missingPieces = [];
        if (!role) missingPieces.push('role');
        if (!ariaLabel && !ariaLabelledby && !hasMeaningfulText) {
          missingPieces.push('accessible name');
        }

        if (missingPieces.length > 0) {
          const sourceSnippet = $.html(el);
          const line = lineOf(file.content, sourceSnippet);
          const key = `${file.path}|${line}|${sourceSnippet}`;

          if (!seen.has(key)) {
            seen.add(key);
            violations.push({
              file: file.path,
              line,
              column: null,
              snippet: snippet(file.content, line),
              message: `Custom interactive element is missing: ${missingPieces.join(' and ')}. Add a role attribute and ensure the element has an accessible name via text content, aria-label, or aria-labelledby.`,
              severity: 'serious',
              criterion: '4.1.2'
            });
          }
        }
      });
    }

    return violations;
  }
};
