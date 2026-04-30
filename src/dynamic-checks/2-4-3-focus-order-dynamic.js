/**
 * 2.4.3 Focus Order (Dynamic)
 * Detects focus order violations by analyzing tabindex values and DOM flow.
 * Checks for positive tabindex values (anti-pattern) and logical flow deviations.
 */

const ax = require('../lib/ax-tree-adapter');

module.exports = {
  id: '2.4.3',
  name: 'Focus Order',
  level: 'A',
  wcagIntroduced: '2.0',
  url: 'https://www.w3.org/WAI/WCAG22/Understanding/focus-order',

  async run(ctx) {
    const violations = [];

    // Skip if no pages are available
    if (!ctx.pages || !Array.isArray(ctx.pages)) {
      return violations;
    }

    for (const pageRecord of ctx.pages) {
      // Skip pages with errors or missing axTree
      if (pageRecord.error || !pageRecord.axTree) {
        continue;
      }

      try {
        // Prefer DOM-derived tabindex values when the runner has provided them
        // (chromium AX tree omits `tabindex` from properties — see
        // run-dynamic-checks.js). Falls back to AX-tree extraction otherwise.
        const explicit = Array.isArray(pageRecord.explicitTabindex)
          ? pageRecord.explicitTabindex
          : null;

        // Check 1: Flag any element with explicit positive tabindex
        if (explicit && explicit.length > 0) {
          for (const item of explicit) {
            if (typeof item.tabindex === 'number' && item.tabindex > 0) {
              violations.push({
                file: pageRecord.path,
                line: null,
                column: null,
                snippet: item.outerHTML || `tabindex="${item.tabindex}"`,
                message: `Element <${item.tag || 'element'}> has explicit tabindex=${item.tabindex} (positive). Positive tabindex values disrupt the natural focus order and make keyboard navigation unpredictable. Use tabindex="0" for custom interactive elements or omit tabindex to rely on natural DOM order.`,
                severity: 'serious',
                confidence: 'definitive',
                criterion: '2.4.3',
              });
            }
          }
        }

        // Extract the focusable sequence from the accessibility tree
        // (used for the heuristic order check below; falls back to flagging
        // positive tabindex if `explicit` was not provided)
        const focusableSequence = ax.extractFocusableSequence(pageRecord.axTree);

        if (!explicit) {
          for (const focusable of focusableSequence) {
            const tabindex = focusable.tabindex;
            if (typeof tabindex === 'number' && tabindex > 0) {
              violations.push({
                file: pageRecord.path,
                line: null,
                column: null,
                snippet: `tabindex="${tabindex}"`,
                message: `Element has explicit tabindex=${tabindex} (positive). Positive tabindex values disrupt the natural focus order and make keyboard navigation unpredictable. Use tabindex="0" for custom interactive elements or omit tabindex to rely on natural DOM order.`,
                severity: 'serious',
                confidence: 'definitive',
                criterion: '2.4.3',
              });
            }
          }
        }

        // Check 2: Heuristic check for logical DOM order violations
        // Only flag if there are multiple focusable elements with explicit tabindex values
        const withExplicitTabindex = focusableSequence.filter(
          (f) => typeof f.tabindex === 'number' && f.tabindex >= 0
        );

        if (withExplicitTabindex.length > 1) {
          // Check if tabindex values are in ascending order (expected) or if there are significant jumps backward
          let hasBackwardsJump = false;
          let previousTabindex = -1;

          for (let i = 0; i < withExplicitTabindex.length; i++) {
            const current = withExplicitTabindex[i].tabindex;

            // Skip tabindex="0" which should appear at the end naturally
            if (current === 0) {
              continue;
            }

            // If previous was non-zero and current is lower, it's a backwards jump
            if (previousTabindex > 0 && current > 0 && current < previousTabindex) {
              hasBackwardsJump = true;
              break;
            }

            if (current > 0) {
              previousTabindex = current;
            }
          }

          if (hasBackwardsJump) {
            // Find the specific elements causing the issue
            const tabindexValues = withExplicitTabindex
              .map((f) => f.tabindex)
              .filter((t) => t > 0)
              .join(', ');

            violations.push({
              file: pageRecord.path,
              line: null,
              column: null,
              snippet: `tabindex values: ${tabindexValues}`,
              message: `Focus order may be illogical. Found tabindex values (${tabindexValues}) that suggest focus may jump backwards or skip elements. Verify that the focus order follows a logical left-to-right, top-to-bottom flow matching user expectations.`,
              severity: 'moderate',
              confidence: 'heuristic',
              criterion: '2.4.3',
            });
          }
        }
      } catch (err) {
        // Log error but don't crash; continue to next page
        console.warn(
          `Focus order check error on ${pageRecord.path}: ${err.message}`
        );
      }
    }

    return violations;
  },
};
