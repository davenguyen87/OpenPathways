/**
 * 1.4.3 Contrast (minimum)
 * Analyzes text/background color pairs for WCAG AA contrast compliance (4.5:1 normal, 3:1 large).
 * Uses static CSS parsing to extract color values and computes contrast ratios directly.
 */

const { lineOf } = require('../lib/line-of');
const { snippet } = require('../lib/snippet');

let resolve;
try {
  resolve = require('@asamuzakjp/css-color').resolve;
} catch (e) {
  resolve = null;
}

// Helper functions

function parseColorRules(cssContent) {
  const map = {};
  const ruleRegex = /([^{]+)\s*\{\s*([^}]+)\}/g;
  let match;

  while ((match = ruleRegex.exec(cssContent)) !== null) {
    const selectors = match[1].split(',').map(s => s.trim());
    const declarations = match[2];

    const color = extractColorFromDecl(declarations);
    const bgColor = extractBgColorFromDecl(declarations);

    for (const selector of selectors) {
      if (selector && (color || bgColor)) {
        map[selector] = { color, background: bgColor };
      }
    }
  }

  return map;
}

function extractColorFromDecl(decl) {
  const match = decl.match(/color\s*:\s*([^;]+)/i);
  if (match) {
    return normalizeColor(match[1].trim());
  }
  return null;
}

function extractBgColorFromDecl(decl) {
  const match = decl.match(/background(?:-color)?\s*:\s*([^;]+)/i);
  if (match) {
    return normalizeColor(match[1].trim());
  }
  return null;
}

function extractColorFromStyle(style) {
  if (!style) return null;
  const match = style.match(/color\s*:\s*([^;]+)/i);
  if (match) {
    return normalizeColor(match[1].trim());
  }
  return null;
}

function extractBgColorFromStyle(style) {
  if (!style) return null;
  const match = style.match(/background(?:-color)?\s*:\s*([^;]+)/i);
  if (match) {
    return normalizeColor(match[1].trim());
  }
  return null;
}

function normalizeColor(colorStr) {
  if (!colorStr) return null;
  try {
    return resolve(colorStr);
  } catch {
    return null;
  }
}

function parseRGB(rgbStr) {
  const match = rgbStr?.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (match) {
    return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
  }
  return [0, 0, 0];
}

function getLuminance(rgbStr) {
  const [r, g, b] = parseRGB(rgbStr);
  const rgb = [r / 255, g / 255, b / 255].map(v => {
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function computeContrastRatio(color1, color2) {
  const l1 = getLuminance(color1);
  const l2 = getLuminance(color2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

module.exports = {
  id: '1.4.3',
  name: 'Contrast (minimum)',
  level: 'AA',
  wcagIntroduced: '2.0',
  url: 'https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum',

  async run(ctx) {
    if (!resolve) {
      return [{
        file: '<package>',
        line: null,
        column: null,
        snippet: '',
        message: 'Skipped — CSS color parser not available. Run `npm install` first.',
        severity: 'minor'
      }];
    }

    const violations = [];

    // Collect CSS from external files and inline <style> tags
    let cssAllContent = ctx.files.css.map(f => f.content).join('\n');

    // Also extract inline CSS from HTML files
    for (const htmlFile of ctx.files.html) {
      const inlineStyles = htmlFile.content.match(/<style[^>]*>([\s\S]*?)<\/style>/g) || [];
      for (const styleBlock of inlineStyles) {
        const match = styleBlock.match(/<style[^>]*>([\s\S]*?)<\/style>/);
        if (match) {
          cssAllContent += '\n' + match[1];
        }
      }
    }

    // Parse CSS to extract color properties by selector
    const colorMap = parseColorRules(cssAllContent);

    for (const htmlFile of ctx.files.html) {
      try {
        const $ = htmlFile.$();

        // Find all text-bearing elements
        const textElements = $('p, span, div, h1, h2, h3, h4, h5, h6, li, td, th, label, button, a, body, main, section, article, aside, nav');

        textElements.each((i, el) => {
          const $el = $(el);
          const text = $el.text().trim();

          // Skip empty elements
          if (!text) return;

          // Get class and tag info for selector matching
          const classes = $el.attr('class') ? $el.attr('class').split(/\s+/).map(c => `.${c}`) : [];
          const tag = el.tagName.toLowerCase();

          // Inline style has highest priority
          let color = extractColorFromStyle($el.attr('style'));
          let bgColor = extractBgColorFromStyle($el.attr('style'));

          // Fall back to CSS rules for class/tag selectors
          if (!color || !bgColor) {
            // Check class selectors first (most specific)
            for (const className of classes) {
              const rule = colorMap[className];
              if (rule) {
                if (!color && rule.color) color = rule.color;
                if (!bgColor && rule.background) bgColor = rule.background;
              }
            }
          }

          // Fall back to tag selector
          if (!color || !bgColor) {
            const rule = colorMap[tag];
            if (rule) {
              if (!color && rule.color) color = rule.color;
              if (!bgColor && rule.background) bgColor = rule.background;
            }
          }

          // If still missing, check parent/ancestor elements recursively
          if (!color || !bgColor) {
            let parent = el.parent;
            while (parent && (!color || !bgColor)) {
              const pTag = parent.name?.toLowerCase?.();
              const pClasses = parent.attribs?.class ? parent.attribs.class.split(/\s+/).map(c => `.${c}`) : [];
              const pStyle = parent.attribs?.style;

              // Check parent inline style first
              if (pStyle) {
                if (!color) color = extractColorFromStyle(pStyle);
                if (!bgColor) bgColor = extractBgColorFromStyle(pStyle);
              }

              // Check parent CSS rules
              if (!color || !bgColor) {
                for (const className of pClasses) {
                  const rule = colorMap[className];
                  if (rule) {
                    if (!color && rule.color) color = rule.color;
                    if (!bgColor && rule.background) bgColor = rule.background;
                  }
                }
              }

              if (!color || !bgColor) {
                const rule = colorMap[pTag];
                if (rule) {
                  if (!color && rule.color) color = rule.color;
                  if (!bgColor && rule.background) bgColor = rule.background;
                }
              }

              parent = parent.parent;
            }
          }

          // Only check contrast if we have explicit color definitions
          // Skip if both are undefined (use browser defaults we can't verify)
          if (!color || !bgColor) return;

          // Compute contrast
          const ratio = computeContrastRatio(color, bgColor);
          const minRatio = 4.5; // AA level for normal text

          if (ratio < minRatio) {
            const html = $.html(el).slice(0, 200);
            const line = lineOf(htmlFile.content, html);

            violations.push({
              file: htmlFile.path,
              line,
              column: null,
              snippet: snippet(htmlFile.content, line, 200),
              message: `Text (${color}) on background (${bgColor}) has contrast ratio ${ratio.toFixed(2)}:1, below WCAG AA minimum of 4.5:1 for normal text.`,
              severity: ratio < 3 ? 'serious' : 'moderate',
              criterion: '1.4.3'
            });
          }
        });
      } catch (err) {
        violations.push({
          file: htmlFile.path,
          line: null,
          column: null,
          snippet: '',
          message: `Contrast analysis on ${htmlFile.path} failed: ${err.message}. Other checks unaffected.`,
          severity: 'minor'
        });
      }
    }

    return violations;
  }
};
