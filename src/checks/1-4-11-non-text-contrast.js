/**
 * 1.4.11 Non-text contrast
 * Analyzes UI component and graphical element contrast for WCAG AA compliance (3:1 minimum).
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
    const borderColor = extractBorderColorFromDecl(declarations);

    for (const selector of selectors) {
      if (selector && (color || bgColor || borderColor)) {
        map[selector] = { color, background: bgColor, border: borderColor };
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

function extractBorderColorFromDecl(decl) {
  const match = decl.match(/border(?:-color)?\s*:\s*([^;]+)/i);
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

function extractBorderColorFromStyle(style) {
  if (!style) return null;
  const match = style.match(/border(?:-color)?\s*:\s*([^;]+)/i);
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
  id: '1.4.11',
  name: 'Non-text contrast',
  level: 'AA',
  wcagIntroduced: '2.1',
  url: 'https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast',

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

    const colorMap = parseColorRules(cssAllContent);

    for (const htmlFile of ctx.files.html) {
      try {
        const $ = htmlFile.$();

        // UI elements that need non-text contrast (buttons, links, borders, etc.)
        const uiSelectors = ['button', 'a', 'input[type="button"]', 'input[type="submit"]', '[role="button"]'];

        $(uiSelectors.join(',')).each((i, el) => {
          const $el = $(el);

          // Get styles
          let color = extractColorFromStyle($el.attr('style'));
          let bgColor = extractBgColorFromStyle($el.attr('style'));
          let borderColor = extractBorderColorFromStyle($el.attr('style'));

          // Fall back to CSS rules
          const classes = $el.attr('class') ? $el.attr('class').split(/\s+/).map(c => `.${c}`) : [];
          const tag = el.tagName.toLowerCase();

          for (const className of classes) {
            const rule = colorMap[className];
            if (rule) {
              if (!color && rule.color) color = rule.color;
              if (!bgColor && rule.background) bgColor = rule.background;
              if (!borderColor && rule.border) borderColor = rule.border;
            }
          }

          const rule = colorMap[tag];
          if (rule) {
            if (!color && rule.color) color = rule.color;
            if (!bgColor && rule.background) bgColor = rule.background;
            if (!borderColor && rule.border) borderColor = rule.border;
          }

          // Default colors
          if (!color) color = '#000000';
          if (!bgColor) bgColor = '#ffffff';
          if (!borderColor) borderColor = '#000000';

          // Check contrast: use border/outline color if available, else bg
          const checkColor = borderColor || bgColor;
          const ratio = computeContrastRatio(checkColor, bgColor);
          const minRatio = 3; // WCAG AA for non-text

          if (ratio < minRatio) {
            const html = $.html(el).slice(0, 150);
            const line = lineOf(htmlFile.content, html);

            violations.push({
              file: htmlFile.path,
              line,
              column: null,
              snippet: snippet(htmlFile.content, line, 200),
              message: `UI component (${tag}) has insufficient contrast ratio ${ratio.toFixed(2)}:1, below WCAG AA minimum of 3:1. Ensure component indicators (border, outline, background) contrast with adjacent colors.`,
              severity: 'serious',
              criterion: '1.4.11'
            });
          }
        });
      } catch (err) {
        violations.push({
          file: htmlFile.path,
          line: null,
          column: null,
          snippet: '',
          message: `Non-text contrast analysis on ${htmlFile.path} failed: ${err.message}. Other checks unaffected.`,
          severity: 'minor'
        });
      }
    }

    return violations;
  }
};
