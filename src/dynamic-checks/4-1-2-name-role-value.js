/**
 * 4.1.2 Name, Role, Value — DYNAMIC complement.
 *
 * The static check (src/checks/4-1-2-name-role-value.js) inspects HTML source
 * for missing aria-label / labelledby / text on custom interactive elements.
 * It's necessary but not sufficient: things like <button id="x"></button> with
 * a name injected at runtime via JavaScript, or labels resolved through a
 * complex aria-labelledby chain, only become testable once the page is alive.
 *
 * This dynamic check walks the rendered Accessibility Tree captured by
 * ctx.pages[].axTree and flags any node with an interactive role whose
 * computed accessible name is empty.
 *
 * Shares criterion id 4.1.2 with the static check; the orchestrator merges
 * violations under the same criterion and de-dupes the scorecard entry.
 */

const { walk } = require('../lib/ax-tree-adapter');

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'radio',
  'checkbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
]);

// Roles that legitimately have no name in the AX tree (decorative or grouping).
const SKIP_ROLES = new Set(['none', 'presentation', 'generic']);

module.exports = {
  id: '4.1.2',
  name: 'Name, role, value',
  level: 'A',
  wcagIntroduced: '2.0',
  url: 'https://www.w3.org/WAI/WCAG22/Understanding/name-role-value',

  async run(ctx) {
    const violations = [];

    if (!Array.isArray(ctx.pages) || ctx.pages.length === 0) {
      return violations;
    }

    for (const pageRecord of ctx.pages) {
      if (!pageRecord || !pageRecord.axTree) continue;

      walk(pageRecord.axTree, (node) => {
        const role = (node.role || '').toLowerCase();
        if (!INTERACTIVE_ROLES.has(role)) return;
        if (SKIP_ROLES.has(role)) return;

        // Disabled/hidden interactive nodes don't need names.
        if (node.properties && (node.properties.disabled || node.properties.hidden)) {
          return;
        }

        const name = (node.name || '').trim();
        if (name.length > 0) return;

        // Some controls take their name from `value` (e.g. submit inputs).
        const valueName = (node.value || '').trim();
        if (valueName.length > 0) return;

        violations.push({
          criterion: '4.1.2',
          file: pageRecord.path,
          line: null,
          column: null,
          snippet: `<${role}>`,
          message: `Interactive element with role="${role}" has no accessible name in the rendered Accessibility Tree. Screen readers will announce it as unlabeled.`,
          severity: 'serious',
          confidence: 'definitive',
          source: 'dynamic',
        });
      });
    }

    return violations;
  },
};
