/**
 * 3.2.6 Consistent help
 * Flag help mechanisms that appear inconsistently across SCOs (entry points).
 */

const { lineOf } = require('../lib/line-of');
const { snippet } = require('../lib/snippet');

module.exports = {
  id: '3.2.6',
  name: 'Consistent help',
  level: 'A',
  wcagIntroduced: '2.2',
  url: 'https://www.w3.org/WAI/WCAG22/Understanding/consistent-help',

  async run(ctx) {
    const violations = [];

    // Skip single-SCO packages
    if (ctx.entryPoints.length < 2) {
      return violations;
    }

    // Build map: { filePath: Set<helpType> }
    // helpType = normalized action signal (mailto, tel, chat, phone, email, link-to-page)
    const helpMap = new Map();

    for (const file of ctx.files.html) {
      const $ = file.$();
      const helpTypes = new Set();

      // Find elements with text/aria-label/title containing help|support|contact
      $('*').each((i, el) => {
        const $el = $(el);
        const text = $el.text().toLowerCase();
        const ariaLabel = ($el.attr('aria-label') || '').toLowerCase();
        const title = ($el.attr('title') || '').toLowerCase();
        const combined = text + ariaLabel + title;

        if (!/help|support|contact/i.test(combined)) return;

        // Determine the help type from this element
        const href = $el.attr('href') || '';
        const onclick = $el.attr('onclick') || '';

        if (href.startsWith('mailto:')) {
          helpTypes.add('mailto');
        } else if (href.startsWith('tel:')) {
          helpTypes.add('tel');
        } else if (/chat|live.?chat|messaging/i.test(combined)) {
          helpTypes.add('chat');
        } else if (/phone|call|talk/i.test(combined)) {
          helpTypes.add('phone');
        } else if (/email|mail/i.test(combined) && !href.startsWith('mailto:')) {
          helpTypes.add('email');
        } else if (href && href.length > 0 && !href.startsWith('#')) {
          helpTypes.add('link-to-page');
        }
      });

      if (helpTypes.size > 0) {
        helpMap.set(file.path, helpTypes);
      }
    }

    // Build entry point map
    const entryPointHelpMap = new Map();
    for (const entryPoint of ctx.entryPoints) {
      // Find the corresponding file
      const file = ctx.files.html.find(f => f.path === entryPoint);
      if (!file) continue;

      // Merge all help types found in this entry point (and any related files)
      const $ = file.$();
      const helpTypes = new Set();

      $('*').each((i, el) => {
        const $el = $(el);
        const text = ($el.text() || '').toLowerCase();
        const ariaLabel = ($el.attr('aria-label') || '').toLowerCase();
        const title = ($el.attr('title') || '').toLowerCase();
        const combined = text + ariaLabel + title;

        if (!/help|support|contact/i.test(combined)) return;

        const href = $el.attr('href') || '';

        if (href.startsWith('mailto:')) {
          helpTypes.add('mailto');
        } else if (href.startsWith('tel:')) {
          helpTypes.add('tel');
        } else if (/chat|live.?chat|messaging/i.test(combined)) {
          helpTypes.add('chat');
        } else if (/phone|call|talk/i.test(combined)) {
          helpTypes.add('phone');
        } else if (/email|mail/i.test(combined) && !href.startsWith('mailto:')) {
          helpTypes.add('email');
        } else if (href && href.length > 0 && !href.startsWith('#')) {
          helpTypes.add('link-to-page');
        }
      });

      entryPointHelpMap.set(entryPoint, helpTypes);
    }

    // Compare help mechanisms across entry points
    const allHelpTypes = new Set();
    for (const helpSet of entryPointHelpMap.values()) {
      for (const h of helpSet) allHelpTypes.add(h);
    }

    // For each entry point, check if it's missing a help mechanism present elsewhere
    for (const [entryPoint, helpTypes] of entryPointHelpMap.entries()) {
      const missingTypes = [];
      for (const helpType of allHelpTypes) {
        if (!helpTypes.has(helpType)) {
          missingTypes.push(helpType);
        }
      }

      if (missingTypes.length > 0) {
        const file = ctx.files.html.find(f => f.path === entryPoint);
        if (!file) continue;

        const sourceSnippet = file.content.substring(0, 100);
        const line = lineOf(file.content, sourceSnippet);

        // Build message showing which entry points have which help mechanisms
        const helpSummary = Array.from(entryPointHelpMap.entries())
          .map(([ep, types]) => `${ep}: ${Array.from(types).join(', ') || 'none'}`)
          .join('; ');

        violations.push({
          file: entryPoint,
          line,
          column: null,
          snippet: snippet(file.content, line),
          message: `Help mechanisms are inconsistent across SCOs. This SCO lacks: ${missingTypes.join(', ')}. Help summary: ${helpSummary}`,
          severity: 'moderate',
          criterion: '3.2.6'
        ,
              confidence: 'heuristic'
            });
      }
    }

    return violations;
  }
};
