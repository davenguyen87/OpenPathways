/**
 * 1.4.10 Reflow
 * Detects CSS rules with fixed dimensions >= 321px combined with overflow hidden/scroll,
 * and viewport meta tags that prevent zooming (reflow concern).
 */

const { lineOf } = require('../lib/line-of');
const { snippet } = require('../lib/snippet');

module.exports = {
  id: '1.4.10',
  name: 'Reflow',
  level: 'AA',
  wcagIntroduced: '2.1',
  url: 'https://www.w3.org/WAI/WCAG22/Understanding/reflow',

  async run(ctx) {
    const violations = [];
    const seen = new Set();

    // Check CSS files for fixed-dimension + overflow: hidden/scroll
    for (const file of ctx.files.css) {
      // Split into rule blocks
      const rules = file.content.split(/}\s*/);

      for (let i = 0; i < rules.length - 1; i++) {
        const ruleBlock = rules[i];

        // Check for dimension >= 321px
        const dimensionMatch = ruleBlock.match(
          /(height|width)\s*:\s*(\d{3,})px/i
        );
        if (!dimensionMatch) continue;

        const dimension = parseInt(dimensionMatch[2], 10);
        if (dimension < 321) continue;

        // Check for overflow: hidden or scroll
        const hasOverflow = /overflow(?:-x|-y)?\s*:\s*(hidden|scroll)/i.test(
          ruleBlock
        );
        if (!hasOverflow) continue;

        // Found violation: dimension >= 321 AND overflow hidden/scroll
        const blockStart = rules.slice(0, i).join('}').length;
        const line = lineOf(file.content, blockStart);
        const key = `${file.path}|${line}|reflow-overflow`;

        if (!seen.has(key)) {
          seen.add(key);
          violations.push({
              file: file.path,
              line,
              column: null,
              snippet: snippet(file.content, line),
              message: 'CSS rule sets a fixed width or height >= 321px with overflow: hidden or scroll. This forces horizontal scrolling at 320px viewport width, preventing content reflow. Use flexible dimensions (%, em, vw) or increase the viewport width threshold.',
            severity: 'moderate',
            criterion: '1.4.10',
              confidence: 'heuristic'
          });
        }
      }
    }

    // Check viewport meta tags for zoom-blocking (same as 1.4.4 but with different message)
    for (const file of ctx.files.html) {
      const $ = file.$();

      $('meta[name="viewport"]').each((i, el) => {
        const $meta = $(el);
        const content = ($meta.attr('content') || '').toLowerCase();

        // Check for user-scalable=no or user-scalable=0
        const hasNoScale = /user-scalable\s*=\s*(no|0)\b/i.test(content);

        // Check for maximum-scale < 2
        const maxScaleMatch = content.match(/maximum-scale\s*=\s*([\d.]+)/i);
        const hasLowMaxScale =
          maxScaleMatch && parseFloat(maxScaleMatch[1]) < 2;

        if (hasNoScale || hasLowMaxScale) {
          const sourceSnippet = $.html(el);
          const line = lineOf(file.content, sourceSnippet);
          const key = `${file.path}|${line}|reflow-viewport`;

          if (!seen.has(key)) {
            seen.add(key);
            violations.push({
              file: file.path,
              line,
              column: null,
              snippet: snippet(file.content, line),
              message:
                'Viewport prevents zoom (user-scalable=no or maximum-scale < 2); users cannot reflow content at 320px width. Remove user-scalable=no and set maximum-scale to at least 2 or higher to allow users to reflow content.',
              severity: 'serious',
              criterion: '1.4.10',
              confidence: 'definitive'
            });
          }
        }
      });
    }

    return violations;
  }
};
