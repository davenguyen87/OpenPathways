/**
 * 2.4.7 Focus visible
 * Pure CSS scan: detects CSS rules with outline: none/0 that lack a replacement focus indicator.
 * Also scans inline <style> blocks from HTML files.
 */

const { lineOf } = require('../lib/line-of');
const { snippet } = require('../lib/snippet');
const cheerio = require('cheerio');

module.exports = {
  id: '2.4.7',
  name: 'Focus visible',
  level: 'AA',
  wcagIntroduced: '2.0',
  url: 'https://www.w3.org/WAI/WCAG22/Understanding/focus-visible',

  async run(ctx) {
    const violations = [];

    // Scan external CSS files
    for (const cssFile of ctx.files.css) {
      try {
        violations.push(...scanCssContent(cssFile.content, cssFile.path));
      } catch (err) {
        violations.push({
          file: cssFile.path,
          line: 1,
          column: null,
          snippet: '',
          message: `Focus visibility analysis skipped: ${err.message}`,
          severity: 'minor'
        });
      }
    }

    // Scan inline <style> blocks from HTML files
    for (const htmlFile of ctx.files.html) {
      try {
        const $ = cheerio.load(htmlFile.content);
        $('style').each((idx, elem) => {
          const styleContent = $(elem).text();
          const styleViolations = scanCssContent(styleContent, htmlFile.path);
          
          // For inline styles, compute line number relative to the HTML file
          styleViolations.forEach((v) => {
            if (v.line !== null) {
              const styleStartLine = lineOf(htmlFile.content, htmlFile.content.indexOf('<style'));
              v.line = styleStartLine + (v.line - 1);
            }
          });
          
          violations.push(...styleViolations);
        });
      } catch (err) {
        violations.push({
          file: htmlFile.path,
          line: 1,
          column: null,
          snippet: '',
          message: `Focus visibility analysis skipped: ${err.message}`,
          severity: 'minor'
        });
      }
    }

    return violations;
  }
};

/**
 * Scan CSS content for focus visibility issues.
 * @param {string} cssContent - CSS text
 * @param {string} filePath - File path for reporting
 * @returns {array} Array of violations
 */
function scanCssContent(cssContent, filePath) {
  const violations = [];

  // Split CSS into rule blocks
  const blocks = cssContent.split('}');
  
  for (let blockIdx = 0; blockIdx < blocks.length - 1; blockIdx++) {
    const block = blocks[blockIdx];
    const nextBlock = blockIdx + 1 < blocks.length ? blocks[blockIdx + 1] : '';

    // Check if this block has outline: none or outline: 0
    const hasOutlineNone = /outline:\s*(none|0|0px)/i.test(block);
    if (!hasOutlineNone) continue;

    // Check if same block has a replacement focus indicator
    const hasReplacement = /box-shadow:|border:|outline-color:|outline-width:|outline-style:/i.test(block);
    if (hasReplacement) continue;

    // Extract the selector from the block
    const blockContent = block + '}';
    const openBrace = block.lastIndexOf('{');
    if (openBrace === -1) continue;

    const selector = block.substring(0, openBrace).trim().split('\n').pop();
    if (!selector) continue;

    // Check if there's a :focus or :focus-visible variant elsewhere in the file
    const baseSelectorPattern = selector.replace(/:focus-visible|:focus/g, '').trim();
    const focusRegex = new RegExp(
      `${baseSelectorPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\s*(:focus|:focus-visible)\s*{[^}]*(box-shadow|outline|border)[^}]*}`,
      'i'
    );

    const hasFocusAlternative = focusRegex.test(cssContent);

    if (!hasFocusAlternative) {
      // Find the line number of this rule
      const ruleStart = cssContent.indexOf(selector + '{');
      const line = lineOf(cssContent, ruleStart !== -1 ? ruleStart : 0);

      violations.push({
        file: filePath,
        line,
        column: null,
        snippet: snippet(cssContent, line),
        message: `CSS rule for "${selector}" removes focus indicator with outline: none/0 without providing a replacement focus style. Add a :focus or :focus-visible rule with outline, box-shadow, or border.`,
        severity: 'serious',
        criterion: '2.4.7'
      });
    }
  }

  return violations;
}
