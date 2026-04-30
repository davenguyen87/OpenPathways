/**
 * 2.1.2 No keyboard trap
 * Flag dialog/modal elements that lack a detectable close mechanism.
 */

const { lineOf } = require('../lib/line-of');
const { snippet } = require('../lib/snippet');

module.exports = {
  id: '2.1.2',
  name: 'No keyboard trap',
  level: 'A',
  wcagIntroduced: '2.0',
  url: 'https://www.w3.org/WAI/WCAG22/Understanding/no-keyboard-trap',

  async run(ctx) {
    const violations = [];
    const seen = new Set();

    for (const file of ctx.files.html) {
      const $ = file.$();

      // Find elements with role="dialog" or modal class names
      $('[role="dialog"], .modal, .dialog, .popup, .lightbox, .overlay').each((i, el) => {
        const $el = $(el);

        // Check for close button/link inside this element's subtree
        let hasCloseButton = false;

        // Look for button/link with aria-label="Close" or text matching close pattern
        const closePattern = /^(close|cancel|×|✕|✖|x)$/i;
        $el.find('button, a').each((j, closeEl) => {
          const $closeEl = $(closeEl);
          const ariaLabel = $closeEl.attr('aria-label');
          const text = $closeEl.text().trim();
          const dataAttr =
            $closeEl.attr('data-dismiss') || $closeEl.attr('data-close');

          if (
            ariaLabel === 'Close' ||
            closePattern.test(text) ||
            dataAttr
          ) {
            hasCloseButton = true;
            return false; // break
          }
        });

        if (hasCloseButton) return; // This dialog has a close button

        // Check JS files for Escape handler near modal selectors
        let hasEscapeHandler = false;
        const modalSelector = $el.attr('class') || $el.attr('id');

        if (modalSelector) {
          for (const jsFile of ctx.files.js) {
            // Simple heuristic: look for 'Escape' key handler in JS and modal-like selector in same file
            if (jsFile.content.includes('Escape') && jsFile.content.includes(modalSelector)) {
              hasEscapeHandler = true;
              break;
            }
          }
        }

        if (!hasEscapeHandler) {
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
              message:
                'No close button detected. Verify keyboard users can dismiss this dialog (via Escape key or a visible close button).',
              severity: 'serious',
              criterion: '2.1.2'
            ,
              confidence: 'heuristic'
            });
          }
        }
      });
    }

    return violations;
  }
};
