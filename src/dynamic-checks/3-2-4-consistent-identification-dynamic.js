/**
 * 3.2.4 Consistent Identification (Dynamic)
 * Cross-SCO label consistency check. Scans interactive elements across all pages
 * and flags inconsistent labels for functionally similar elements.
 */

const ax = require('../lib/ax-tree-adapter');

module.exports = {
  id: '3.2.4',
  name: 'Consistent Identification',
  level: 'AA',
  wcagIntroduced: '2.0',
  url: 'https://www.w3.org/WAI/WCAG22/Understanding/consistent-identification',

  async run(ctx) {
    const violations = [];

    // Skip if fewer than 2 pages; consistency check requires cross-page comparison
    if (!ctx.pages || ctx.pages.length < 2) {
      return violations;
    }

    try {
      // Build a map of { role: { position: [{ pagePath, name, label }] } }
      // to group elements by role and approximate position in page sequence
      const elementsByRoleAndPosition = {};

      // Interactive roles we care about for consistency checking
      const interactiveRoles = new Set([
        'button',
        'link',
        'checkbox',
        'radio',
        'switch',
        'menuitem',
        'tab',
      ]);

      // Extract interactive elements from each page
      for (let pageIndex = 0; pageIndex < ctx.pages.length; pageIndex++) {
        const pageRecord = ctx.pages[pageIndex];

        // Skip pages with errors or missing axTree
        if (pageRecord.error || !pageRecord.axTree) {
          continue;
        }

        // Find all interactive elements
        const allNodes = ax.flatten(pageRecord.axTree);
        let interactiveIndex = 0;

        for (const node of allNodes) {
          const role = (node.role || '').toLowerCase();

          if (!interactiveRoles.has(role)) {
            continue;
          }

          // Use the accessible name as the label
          const label = (node.name || 'unlabeled').trim();

          // Initialize role map if needed
          if (!elementsByRoleAndPosition[role]) {
            elementsByRoleAndPosition[role] = {};
          }

          // Group by position (e.g., first button, second button, etc.)
          const posKey = `pos_${interactiveIndex}`;
          if (!elementsByRoleAndPosition[role][posKey]) {
            elementsByRoleAndPosition[role][posKey] = [];
          }

          elementsByRoleAndPosition[role][posKey].push({
            pagePath: pageRecord.path,
            pageIndex: pageIndex,
            label: label,
            name: node.name,
          });

          interactiveIndex++;
        }
      }

      // Check each role-position group for inconsistencies
      for (const role in elementsByRoleAndPosition) {
        const positionGroups = elementsByRoleAndPosition[role];

        for (const posKey in positionGroups) {
          const elementsAtPosition = positionGroups[posKey];

          // Only check if this position appears on multiple pages
          if (elementsAtPosition.length < 2) {
            continue;
          }

          // Collect unique labels at this position
          const labelSet = new Set(elementsAtPosition.map((e) => e.label));

          // If labels differ, flag a violation per page-pair combination
          if (labelSet.size > 1) {
            // Report violations for each pairwise difference
            for (let i = 0; i < elementsAtPosition.length - 1; i++) {
              const first = elementsAtPosition[i];
              const second = elementsAtPosition[i + 1];

              // Only report if labels actually differ
              if (first.label !== second.label) {
                violations.push({
                  file: second.pagePath,
                  line: null,
                  column: null,
                  snippet: `role="${role}"`,
                  message: `Inconsistent label for ${role} element. Page "${first.pagePath}" uses "${first.label}", but this page uses "${second.label}". Similar components should be labeled consistently across all pages.`,
                  severity: 'moderate',
                  confidence: 'heuristic',
                  criterion: '3.2.4',
                });
              }
            }
          }
        }
      }
    } catch (err) {
      // Log error but don't crash
      console.warn(`Consistent identification check error: ${err.message}`);
    }

    return violations;
  },
};
