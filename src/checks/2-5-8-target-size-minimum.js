/**
 * 2.5.8 Target Size (minimum)
 * Detects interactive targets (buttons, links, inputs, etc.) with computed dimensions < 24x24 CSS pixels,
 * accounting for padding exception.
 */

const { lineOf } = require('../lib/line-of');
const { snippet } = require('../lib/snippet');

module.exports = {
  id: '2.5.8',
  name: 'Target size (minimum)',
  level: 'AA',
  wcagIntroduced: '2.2',
  url: 'https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum',

  async run(ctx) {
    const violations = [];
    const seen = new Set();

    // Check HTML inline styles
    for (const file of ctx.files.html) {
      const $ = file.$();

      // Interactive targets: button, a, input[type=button|submit|reset], role=button|link, summary
      const selectors = [
        'button',
        'a',
        'input[type="button"]',
        'input[type="submit"]',
        'input[type="reset"]',
        '[role="button"]',
        '[role="link"]',
        'summary'
      ];

      selectors.forEach((selector) => {
        $(selector).each((i, el) => {
          const $el = $(el);
          const style = ($el.attr('style') || '').toLowerCase();

          // Parse width and height from inline style
          const widthMatch = style.match(/width\s*:\s*(\d+)px/i);
          const heightMatch = style.match(/height\s*:\s*(\d+)px/i);

          if (!widthMatch || !heightMatch) return;

          const width = parseInt(widthMatch[1], 10);
          const height = parseInt(heightMatch[1], 10);

          if (width >= 24 && height >= 24) return;

          // Check for padding exception: padding >= 4px on all sides
          const paddingMatch = style.match(/padding\s*:\s*(\d+)px/i);
          if (paddingMatch) {
            const padding = parseInt(paddingMatch[1], 10);
            if (padding >= 4) {
              // Approximate: assume padding applies to all sides, effective size = base + 2*padding
              const effectiveWidth = width + 2 * padding;
              const effectiveHeight = height + 2 * padding;
              if (effectiveWidth >= 24 && effectiveHeight >= 24) return;
            }
          }

          // Violation: both dimensions < 24px (without sufficient padding)
          const sourceSnippet = $.html(el);
          const line = lineOf(file.content, sourceSnippet);
          const key = `${file.path}|${line}|target-size`;

          if (!seen.has(key)) {
            seen.add(key);

            const severity =
              width < 16 && height < 16 ? 'serious' : 'moderate';

            violations.push({
              file: file.path,
              line,
              column: null,
              snippet: snippet(file.content, line),
              message:
                `Interactive target (${width}×${height} CSS pixels) is too small. Users with motor control disabilities may struggle to click/tap it. Increase width and height to at least 24×24 CSS pixels, or add spacing (padding/margin ≥ 4px) to increase the effective click area.`,
              severity,
              criterion: '2.5.8'
            });
          }
        });
      });
    }

    // Collect CSS rules from standalone .css files and <style> blocks in HTML
    const cssRuleSets = [];

    // Add standalone CSS files
    for (const file of ctx.files.css) {
      cssRuleSets.push({ content: file.content, filePath: file.path });
    }

    // Extract <style> blocks from HTML files
    for (const file of ctx.files.html) {
      const styleMatches = file.content.match(/<style[^>]*>([\s\S]*?)<\/style>/gi);
      if (styleMatches) {
        for (const styleBlock of styleMatches) {
          const styleContent = styleBlock.replace(/<\/?style[^>]*>/gi, '');
          cssRuleSets.push({ content: styleContent, filePath: file.path });
        }
      }
    }

    // Check CSS rules for button/link selectors with small dimensions
    for (const cssFile of cssRuleSets) {
      const rules = cssFile.content.split(/}\s*/);

      for (let i = 0; i < rules.length - 1; i++) {
        const ruleBlock = rules[i];

        // Check if selector contains button, a, or role="button"
        const selectorLine = ruleBlock.split('{')[0];
        const hasTargetSelector =
          /\b(button|a|input\[type.*button|input\[type.*submit|input\[type.*reset|role\s*=\s*['"](button|link)['"]|summary)\b/i.test(
            selectorLine
          );

        if (!hasTargetSelector) continue;

        // Check for both width and height < 24px
        const widthMatch = ruleBlock.match(
          /width\s*:\s*(\d+)px/i
        );
        const heightMatch = ruleBlock.match(
          /height\s*:\s*(\d+)px/i
        );

        if (!widthMatch || !heightMatch) continue;

        const width = parseInt(widthMatch[1], 10);
        const height = parseInt(heightMatch[1], 10);

        if (width >= 24 && height >= 24) continue;

        // Check for padding exception
        const paddingMatch = ruleBlock.match(
          /padding\s*:\s*(\d+)px/i
        );
        if (paddingMatch) {
          const padding = parseInt(paddingMatch[1], 10);
          if (padding >= 4) {
            const effectiveWidth = width + 2 * padding;
            const effectiveHeight = height + 2 * padding;
            if (effectiveWidth >= 24 && effectiveHeight >= 24) continue;
          }
        }

        // Violation
        const blockStart = rules.slice(0, i).join('}').length;
        const line = lineOf(cssFile.content, blockStart);
        const key = `${cssFile.filePath}|${line}|target-size-css`;

        if (!seen.has(key)) {
          seen.add(key);

          const severity =
            width < 16 && height < 16 ? 'serious' : 'moderate';

          violations.push({
            file: cssFile.filePath,
            line,
            column: null,
            snippet: snippet(cssFile.content, line),
            message:
              `CSS rule targets interactive element (${width}×${height} CSS pixels) which is too small. Increase width and height to at least 24×24 CSS pixels, or add spacing (padding/margin ≥ 4px) to increase the effective click area for users with motor control disabilities.`,
            severity,
            criterion: '2.5.8'
          });
        }
      }
    }

    return violations;
  }
};
