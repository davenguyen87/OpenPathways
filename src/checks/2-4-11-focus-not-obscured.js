/**
 * 2.4.11 Focus not obscured (minimum)
 * Heuristic CSS scan: detects fixed/sticky elements that could obscure focused content below.
 * Scans both external CSS files and inline <style> blocks in HTML.
 * Caps violations per file to avoid noise on layouts with many fixed elements.
 */

const { lineOf } = require('../lib/line-of');
const { snippet } = require('../lib/snippet');
const cheerio = require('cheerio');

module.exports = {
  id: '2.4.11',
  name: 'Focus not obscured (minimum)',
  level: 'AA',
  wcagIntroduced: '2.2',
  url: 'https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum',

  async run(ctx) {
    const violations = [];
    const maxPerFile = 5;

    // External CSS files
    for (const cssFile of ctx.files.css) {
      try {
        violations.push(...scanCssContent(cssFile.content, cssFile.path, maxPerFile));
      } catch (err) {
        violations.push({
          file: cssFile.path,
          line: 1,
          column: null,
          snippet: '',
          message: `Focus obscuration analysis skipped: ${err.message}`,
          severity: 'minor'
        });
      }
    }

    // Inline <style> blocks inside HTML
    for (const htmlFile of ctx.files.html) {
      try {
        const $ = cheerio.load(htmlFile.content);
        $('style').each((_, elem) => {
          const styleText = $(elem).text();
          if (!styleText.trim()) return;

          const styleViolations = scanCssContent(styleText, htmlFile.path, maxPerFile);

          // Translate CSS-local line numbers to HTML-relative line numbers
          const styleStartIdx = htmlFile.content.indexOf('<style');
          const styleStartLine = styleStartIdx !== -1 ? lineOf(htmlFile.content, styleStartIdx) : 1;
          styleViolations.forEach((v) => {
            if (v.line != null) v.line = styleStartLine + (v.line - 1);
          });

          violations.push(...styleViolations);
        });
      } catch (err) {
        violations.push({
          file: htmlFile.path,
          line: 1,
          column: null,
          snippet: '',
          message: `Focus obscuration analysis skipped: ${err.message}`,
          severity: 'minor'
        });
      }
    }

    return violations;
  }
};

/**
 * Scan CSS for position:fixed|sticky rules with top/bottom + height.
 * @param {string} cssContent
 * @param {string} filePath
 * @param {number} maxPerFile
 * @returns {array} Array of violations
 */
function scanCssContent(cssContent, filePath, maxPerFile) {
  const violations = [];
  const blocks = cssContent.split('}');
  let count = 0;

  for (let i = 0; i < blocks.length - 1 && count < maxPerFile; i++) {
    const block = blocks[i];

    const positionMatch = block.match(/position:\s*(fixed|sticky)/i);
    if (!positionMatch) continue;

    const hasAnchor = /(top|bottom):\s*[^;}\s]+/i.test(block);
    const hasHeight = /height:\s*[^;}\s]+/i.test(block);
    if (!hasAnchor || !hasHeight) continue;

    const openBrace = block.lastIndexOf('{');
    if (openBrace === -1) continue;
    const selector = block.substring(0, openBrace).trim().split('\n').pop().trim();
    if (!selector) continue;

    // Locate the rule's starting line in the original content
    const ruleStart = cssContent.indexOf(selector, 0);
    const line = ruleStart !== -1 ? lineOf(cssContent, ruleStart) : 1;

    violations.push({
      file: filePath,
      line,
      column: null,
      snippet: snippet(cssContent, line),
      message: `A position: ${positionMatch[1]} element ("${selector}") may obscure focused interactive content. Manually verify that focused elements remain visible when scrolled, especially for keyboard navigation.`,
      severity: 'moderate',
      criterion: '2.4.11',
      confidence: 'heuristic'
    });

    count++;
  }

  return violations;
}
