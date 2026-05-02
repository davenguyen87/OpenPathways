/**
 * 2.4.7 Focus Visible — DYNAMIC complement.
 *
 * The static check (src/checks/2-4-7-focus-visible.js) scans CSS source for
 * `outline: none` rules without a replacement focus indicator. That's a
 * useful smoke test, but it can't detect indicators added by JavaScript,
 * indicators broken by CSS specificity battles, or focus rings that exist
 * in source but compute to "none" once the cascade resolves.
 *
 * This dynamic check actually focuses each interactive element in the
 * rendered page and reads the computed style. If, when focused, the element
 * has no visible outline AND no box-shadow change from its unfocused state,
 * it's flagged.
 *
 * Heuristic, not exhaustive: a page that signals focus only by background-
 * color change will be flagged here as a false positive. The static + dynamic
 * passes together give better coverage than either alone.
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  '[tabindex]:not([tabindex="-1"])',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="menuitem"]',
].join(',');

module.exports = {
  id: '2.4.7',
  name: 'Focus visible',
  level: 'AA',
  wcagIntroduced: '2.0',
  url: 'https://www.w3.org/WAI/WCAG22/Understanding/focus-visible',

  async run(ctx) {
    const violations = [];

    if (!Array.isArray(ctx.pages) || ctx.pages.length === 0) {
      return violations;
    }

    for (const pageRecord of ctx.pages) {
      if (!pageRecord || !pageRecord.page) continue;

      let findings;
      try {
        findings = await pageRecord.page.evaluate((selector) => {
          const out = [];
          const candidates = Array.from(document.querySelectorAll(selector));
          // Cap to avoid runaway evaluation on giant pages.
          const limit = Math.min(candidates.length, 200);

          for (let i = 0; i < limit; i++) {
            const el = candidates[i];
            // Skip hidden / disabled elements — they aren't reachable anyway.
            const baseStyle = window.getComputedStyle(el);
            if (baseStyle.visibility === 'hidden' || baseStyle.display === 'none') continue;
            if (el.disabled === true) continue;

            const baseOutline = baseStyle.outlineStyle;
            const baseOutlineWidth = parseFloat(baseStyle.outlineWidth) || 0;
            const baseShadow = baseStyle.boxShadow;
            const baseBorder = baseStyle.borderColor;

            // Focus and re-read.
            try {
              el.focus({ preventScroll: true });
            } catch (_) {
              continue;
            }

            const focusedStyle = window.getComputedStyle(el);
            const fOutline = focusedStyle.outlineStyle;
            const fOutlineWidth = parseFloat(focusedStyle.outlineWidth) || 0;
            const fShadow = focusedStyle.boxShadow;
            const fBorder = focusedStyle.borderColor;

            const outlineVisible = fOutline !== 'none' && fOutlineWidth > 0;
            const shadowChanged = fShadow !== baseShadow && fShadow !== 'none';
            const borderChanged = fBorder !== baseBorder;

            if (!outlineVisible && !shadowChanged && !borderChanged) {
              out.push({
                tag: el.tagName ? el.tagName.toLowerCase() : 'element',
                role: el.getAttribute('role') || null,
                outerHTML: (el.outerHTML || '').slice(0, 200),
              });
            }
          }

          // Blur whatever we focused last so we leave the page in a clean state.
          if (document.activeElement && typeof document.activeElement.blur === 'function') {
            document.activeElement.blur();
          }

          return out;
        }, FOCUSABLE_SELECTOR);
      } catch (err) {
        // If the page evaluation blew up, skip this page rather than crash the run.
        continue;
      }

      for (const finding of findings || []) {
        const label = finding.role ? `<${finding.tag} role="${finding.role}">` : `<${finding.tag}>`;
        violations.push({
          criterion: '2.4.7',
          file: pageRecord.path,
          line: null,
          column: null,
          snippet: finding.outerHTML || label,
          message: `${label} has no visible focus indicator when focused (no outline, box-shadow, or border change). Keyboard users can't tell where focus is.`,
          severity: 'serious',
          confidence: 'heuristic',
          source: 'dynamic',
        });
      }
    }

    return violations;
  },
};
