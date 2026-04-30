/**
 * 1.1.1 Non-text content
 * Detects images without alt text, missing role="presentation" on decorative images,
 * and other elements that require text alternatives for screen readers.
 */

const { lineOf } = require('../lib/line-of');
const { snippet } = require('../lib/snippet');

module.exports = {
  id: '1.1.1',
  name: 'Non-text content',
  level: 'A',
  wcagIntroduced: '2.0',
  url: 'https://www.w3.org/WAI/WCAG22/Understanding/non-text-content',

  async run(ctx) {
    const violations = [];
    const seen = new Set();

    for (const file of ctx.files.html) {
      const $ = file.$();

      // Check <img> elements
      $('img').each((i, el) => {
        const $img = $(el);
        const alt = $img.attr('alt');
        const role = $img.attr('role');

        // Flag if alt is missing (null/undefined), but allow alt="" and role="presentation"
        if (typeof alt === 'undefined' && role !== 'presentation' && role !== 'none') {
          const sourceSnippet = $.html(el);
          const line = lineOf(file.content, sourceSnippet);
          const key = `${file.path}|${line}|img`;

          if (!seen.has(key)) {
            seen.add(key);
            violations.push({
              file: file.path,
              line,
              column: null,
              snippet: snippet(file.content, line),
              message:
                'Image is missing an alt attribute. Screen readers will announce nothing meaningful for this image. Add alt="..." describing the image, or alt="" if it is purely decorative.',
              severity: 'critical',
              criterion: '1.1.1'
            });
          }
        }
      });

      // Check <area> elements
      $('area').each((i, el) => {
        const $area = $(el);
        const alt = $area.attr('alt');

        if (typeof alt === 'undefined') {
          const sourceSnippet = $.html(el);
          const line = lineOf(file.content, sourceSnippet);
          const key = `${file.path}|${line}|area`;

          if (!seen.has(key)) {
            seen.add(key);
            violations.push({
              file: file.path,
              line,
              column: null,
              snippet: snippet(file.content, line),
              message:
                'Image map area is missing an alt attribute. Provide alt text describing the clickable region for screen reader users.',
              severity: 'serious',
              criterion: '1.1.1'
            });
          }
        }
      });

      // Check <input type="image"> elements
      $('input[type="image"]').each((i, el) => {
        const $input = $(el);
        const alt = $input.attr('alt');
        const ariaLabel = $input.attr('aria-label');

        if (typeof alt === 'undefined' && !ariaLabel) {
          const sourceSnippet = $.html(el);
          const line = lineOf(file.content, sourceSnippet);
          const key = `${file.path}|${line}|input-image`;

          if (!seen.has(key)) {
            seen.add(key);
            violations.push({
              file: file.path,
              line,
              column: null,
              snippet: snippet(file.content, line),
              message:
                'Image button (input type="image") is missing an alt attribute or aria-label. Provide alt text describing what the button does.',
              severity: 'serious',
              criterion: '1.1.1'
            });
          }
        }
      });
    }

    return violations;
  }
};
