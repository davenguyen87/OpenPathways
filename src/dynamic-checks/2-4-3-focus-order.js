/**
 * 2.4.3 Focus Order — DYNAMIC.
 *
 * Flags positive `tabindex` values (>= 1), which override the natural DOM
 * order and almost always produce a focus order that doesn't match the
 * visual reading order — the textbook 2.4.3 failure.
 *
 * Why dynamic: ctx.pages[].explicitTabindex is collected by the orchestrator
 * directly from the DOM (CDP's accessibility tree doesn't surface tabindex,
 * since it's consumed by the focus engine). Pulling from the live DOM also
 * catches tabindex set by JavaScript at runtime, which a static HTML scan
 * would miss.
 *
 * Note: tabindex="0" makes a non-interactive element focusable in DOM order
 * (legitimate, common for ARIA widgets). tabindex="-1" removes from tab order
 * but keeps programmatically focusable (also legitimate). Only positive
 * values trip this check.
 */

module.exports = {
  id: '2.4.3',
  name: 'Focus order',
  level: 'A',
  wcagIntroduced: '2.0',
  url: 'https://www.w3.org/WAI/WCAG22/Understanding/focus-order',

  async run(ctx) {
    const violations = [];

    if (!Array.isArray(ctx.pages) || ctx.pages.length === 0) {
      return violations;
    }

    for (const pageRecord of ctx.pages) {
      if (!pageRecord || !Array.isArray(pageRecord.explicitTabindex)) continue;

      for (const entry of pageRecord.explicitTabindex) {
        if (!entry || typeof entry.tabindex !== 'number') continue;
        if (Number.isNaN(entry.tabindex)) continue;
        if (entry.tabindex < 1) continue; // 0 and -1 are legitimate

        violations.push({
          criterion: '2.4.3',
          file: pageRecord.path,
          line: null,
          column: null,
          snippet: (entry.outerHTML || `<${entry.tag || 'element'}>`).slice(0, 200),
          message: `Positive tabindex="${entry.tabindex}" on <${entry.tag || 'element'}> overrides natural DOM focus order. Use tabindex="0" or remove the attribute so focus follows the document's reading order.`,
          severity: 'serious',
          confidence: 'definitive',
          source: 'dynamic',
        });
      }
    }

    return violations;
  },
};
