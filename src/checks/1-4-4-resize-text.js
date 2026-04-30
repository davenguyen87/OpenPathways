/**
 * 1.4.4 Resize text
 * Detects viewport meta tags that prevent user scaling (user-scalable=no, maximum-scale < 2).
 */

const { lineOf } = require('../lib/line-of');
const { snippet } = require('../lib/snippet');

module.exports = {
  id: '1.4.4',
  name: 'Resize text',
  level: 'AA',
  wcagIntroduced: '2.0',
  url: 'https://www.w3.org/WAI/WCAG22/Understanding/resize-text',

  async run(ctx) {
    const violations = [];
    const seen = new Set();

    for (const file of ctx.files.html) {
      const $ = file.$();

      $('meta[name="viewport"]').each((i, el) => {
        const $meta = $(el);
        const content = ($meta.attr('content') || '').toLowerCase();

        // Check for user-scalable=no or user-scalable=0
        const hasNoScale = /user-scalable\s*=\s*(no|0)\b/i.test(content);

        // Check for maximum-scale < 2 (including exactly 1)
        const maxScaleMatch = content.match(/maximum-scale\s*=\s*([\d.]+)/i);
        const hasLowMaxScale =
          maxScaleMatch && parseFloat(maxScaleMatch[1]) < 2;

        if (hasNoScale || hasLowMaxScale) {
          const sourceSnippet = $.html(el);
          const line = lineOf(file.content, sourceSnippet);
          const key = `${file.path}|${line}|viewport-no-zoom`;

          if (!seen.has(key)) {
            seen.add(key);
            violations.push({
              file: file.path,
              line,
              column: null,
              snippet: snippet(file.content, line),
              message:
                'Viewport meta tag prevents user scaling (user-scalable=no or maximum-scale < 2). Users with low vision cannot zoom to enlarge text and interface elements. Remove user-scalable=no and set maximum-scale to at least 2 or higher.',
              severity: 'serious',
              criterion: '1.4.4'
            });
          }
        }
      });
    }

    return violations;
  }
};
