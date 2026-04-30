/**
 * 4.1.3 Status Messages (Dynamic)
 * Detects missing aria-live and role="status" regions when the page
 * contains indicators of dynamic feedback content.
 */

const ax = require('../lib/ax-tree-adapter');
const { lineOf } = require('../lib/line-of');
const { snippet } = require('../lib/snippet');

module.exports = {
  id: '4.1.3',
  name: 'Status Messages',
  level: 'AA',
  wcagIntroduced: '2.1',
  url: 'https://www.w3.org/WAI/WCAG22/Understanding/status-messages',

  async run(ctx) {
    const violations = [];

    // Skip if no pages are available
    if (!ctx.pages || !Array.isArray(ctx.pages)) {
      return violations;
    }

    // Heuristic patterns indicating dynamic feedback/status content
    const feedbackPatterns = [
      /feedback/i,
      /correct/i,
      /incorrect/i,
      /score/i,
      /result/i,
      /progress/i,
      /error/i,
      /success/i,
      /message/i,
      /alert/i,
      /notification/i,
      /status/i,
    ];

    for (const pageRecord of ctx.pages) {
      // Skip pages with errors or missing axTree
      if (pageRecord.error || !pageRecord.axTree) {
        continue;
      }

      try {
        // Check 1: Look for live regions in the accessibility tree
        const liveRegions = ax.findLiveRegions(pageRecord.axTree);

        // If page has live regions, confidence is high that status messages are handled
        if (liveRegions.length > 0) {
          continue; // Page has at least one live region; consider it compliant
        }

        // Check 2: Scan the HTML content for indicators of dynamic feedback
        const htmlFile = ctx.files.html.find((f) => f.path === pageRecord.path);
        if (!htmlFile) {
          continue;
        }

        const htmlContent = htmlFile.content;
        let hasFeedbackIndicator = false;
        let matchedPattern = null;

        for (const pattern of feedbackPatterns) {
          // Check class names, id, role attributes, and content
          if (pattern.test(htmlContent)) {
            // Refine: check if the match is in a meaningful context (class, id, role, etc.)
            // rather than just random text
            const contextRegex = new RegExp(
              `(class|id|role|data-[a-z]+)=["']([^"']*${pattern.source}[^"']*)["']`,
              'i'
            );

            if (contextRegex.test(htmlContent)) {
              hasFeedbackIndicator = true;
              matchedPattern = pattern.source;
              break;
            }
          }
        }

        // If page has feedback indicators but no live regions, flag a violation
        if (hasFeedbackIndicator && liveRegions.length === 0) {
          // Try to find the specific line with the feedback indicator
          const feedbackMatch = new RegExp(
            `(class|id|role)=["']([^"']*${matchedPattern}[^"']*)["']`,
            'i'
          );
          const match = feedbackMatch.exec(htmlContent);
          let lineNum = null;

          if (match) {
            lineNum = lineOf(htmlContent, match[0]);
          }

          violations.push({
            file: pageRecord.path,
            line: lineNum,
            column: null,
            snippet:
              lineNum && htmlContent
                ? snippet(htmlContent, lineNum)
                : matchedPattern,
            message: `Page contains dynamic feedback indicators (${matchedPattern}) but no aria-live or role="status" region was detected. Status updates may not be announced to screen readers. Add an aria-live="polite" or aria-live="assertive" region, or use role="status", to ensure dynamic feedback is announced.`,
            severity: 'serious',
            confidence: 'heuristic',
            criterion: '4.1.3',
          });
        }
      } catch (err) {
        // Log error but don't crash; continue to next page
        console.warn(`Status messages check error on ${pageRecord.path}: ${err.message}`);
      }
    }

    return violations;
  },
};
