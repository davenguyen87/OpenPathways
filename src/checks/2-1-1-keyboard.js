/**
 * 2.1.1 Keyboard
 * Flag custom interactive elements (<div>, <span>, <li>, etc.) with onclick or role="button"/"link"
 * that lack tabindex AND keyboard event handlers.
 */

const { lineOf } = require('../lib/line-of');
const { snippet } = require('../lib/snippet');

const NATIVE_INTERACTIVE = new Set(['button', 'a', 'input', 'select', 'textarea', 'summary']);

module.exports = {
  id: '2.1.1',
  name: 'Keyboard',
  level: 'A',
  wcagIntroduced: '2.0',
  url: 'https://www.w3.org/WAI/WCAG22/Understanding/keyboard',

  async run(ctx) {
    const violations = [];
    const seen = new Set();

    for (const file of ctx.files.html) {
      const $ = file.$();

      $('*').each((i, el) => {
        const $el = $(el);
        const tag = el.name.toLowerCase();

        // Skip native interactive elements
        if (NATIVE_INTERACTIVE.has(tag)) return;

        // Check for onclick or role="button"/"link"
        const hasOnclick = $el.attr('onclick');
        const role = $el.attr('role');
        const isButtonOrLink = role === 'button' || role === 'link';

        if (!hasOnclick && !isButtonOrLink) return;

        // Check for tabindex
        const tabindex = $el.attr('tabindex');
        const hasTabindex = typeof tabindex !== 'undefined';

        // Check for keyboard handlers
        const onkeydown = $el.attr('onkeydown');
        const onkeypress = $el.attr('onkeypress');
        const onkeyup = $el.attr('onkeyup');
        const hasKeyHandler = onkeydown || onkeypress || onkeyup;

        // Flag if lacks tabindex AND lacks keyboard handlers
        if (!hasTabindex && !hasKeyHandler) {
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
                'Custom interactive element is not keyboard accessible. Add tabindex="0" and a keyboard event handler (onkeydown/onkeypress) that triggers the same action on Enter or Space.',
              severity: 'serious',
              criterion: '2.1.1'
            });
          }
        }
      });
    }

    return violations;
  }
};
