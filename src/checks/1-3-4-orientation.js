/**
 * 1.3.4 Orientation
 * Detects JS calls to screen.orientation.lock() and CSS orientation media queries
 * that hide content, preventing users from viewing content in their preferred orientation.
 */

const { lineOf } = require('../lib/line-of');
const { snippet } = require('../lib/snippet');

module.exports = {
  id: '1.3.4',
  name: 'Orientation',
  level: 'AA',
  wcagIntroduced: '2.1',
  url: 'https://www.w3.org/WAI/WCAG22/Understanding/orientation',

  async run(ctx) {
    const violations = [];
    const seen = new Set();

    // Check JS files for screen.orientation.lock()
    for (const file of ctx.files.js) {
      const lockMatch = file.content.match(/screen\.orientation\.lock\s*\(/);
      if (lockMatch) {
        const index = file.content.indexOf(lockMatch[0]);
        const line = lineOf(file.content, index);
        const key = `${file.path}|${line}|orientation-lock`;

        if (!seen.has(key)) {
          seen.add(key);
          violations.push({
            file: file.path,
            line,
            column: null,
            snippet: snippet(file.content, line),
            message:
              'JavaScript calls screen.orientation.lock() to force portrait or landscape. This prevents users from rotating their device to view content in their preferred orientation. Remove the lock() call or make it optional.',
            severity: 'serious',
            criterion: '1.3.4'
          });
        }
      }
    }

    // Check CSS files for orientation media queries with display:none or visibility:hidden
    for (const file of ctx.files.css) {
      const orientationRegex = /@media\s*\([^)]*orientation\s*:\s*(portrait|landscape)[^)]*\)\s*\{/gi;
      let mediaMatch;

      while ((mediaMatch = orientationRegex.exec(file.content)) !== null) {
        const blockStart = mediaMatch.index + mediaMatch[0].length;
        let blockEnd = blockStart;
        let braceDepth = 1;

        // Find the closing brace
        for (let i = blockStart; i < file.content.length && braceDepth > 0; i++) {
          if (file.content[i] === '{') braceDepth++;
          if (file.content[i] === '}') braceDepth--;
          blockEnd = i;
        }

        const blockContent = file.content.substring(blockStart, blockEnd);

        // Check if block contains display:none or visibility:hidden
        const hideMatch =
          /display\s*:\s*none|visibility\s*:\s*hidden/i.test(blockContent);

        if (hideMatch) {
          const line = lineOf(file.content, mediaMatch.index);
          const key = `${file.path}|${line}|orientation-hide`;

          if (!seen.has(key)) {
            seen.add(key);
            violations.push({
              file: file.path,
              line,
              column: null,
              snippet: snippet(file.content, line),
              message:
                'CSS orientation media query hides content (display:none or visibility:hidden) based on device orientation. Users with a preferred orientation cannot access this content. Remove the display/visibility rule or restructure the layout to be orientation-agnostic.',
              severity: 'moderate',
              criterion: '1.3.4'
            });
          }
        }
      }
    }

    return violations;
  }
};
