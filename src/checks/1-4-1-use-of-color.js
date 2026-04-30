/**
 * 1.4.1 Use of color
 * Detects color-only references in visible text (e.g., "click the red button").
 */

const { lineOf } = require('../lib/line-of');
const { snippet } = require('../lib/snippet');

module.exports = {
  id: '1.4.1',
  name: 'Use of color',
  level: 'A',
  wcagIntroduced: '2.0',
  url: 'https://www.w3.org/WAI/WCAG22/Understanding/use-of-color',

  async run(ctx) {
    const violations = [];
    const seen = new Set();

    for (const file of ctx.files.html) {
      const $ = file.$();
      const body = $('body');

      if (!body.length) {
        continue;
      }

      // Extract all text nodes from body, excluding <code>, <pre>
      const textContent = extractTextExcludingCode($, body);

      // Patterns for color-only references
      const colorPattern = /\b(click|select|tap|press|see|look at|find)\s+(the\s+)?(red|green|blue|yellow|orange|purple|pink|black|white|gray|grey)\b/gi;
      const inContextPattern = /\bin\s+(red|green|blue|yellow)\b/gi;

      let match;
      const matches = [];

      // Find first pattern matches
      while ((match = colorPattern.exec(textContent.text)) !== null) {
        matches.push({
          phrase: match[0],
          matchedText: textContent.text.substring(match.index, match.index + match[0].length)
        });
      }

      // Find in-context matches with instruction context
      while ((match = inContextPattern.exec(textContent.text)) !== null) {
        const start = Math.max(0, match.index - 100);
        const context = textContent.text.substring(start, match.index + match[0].length + 50);

        // Check if it looks like an instruction (starts with verb or contains "to")
        if (/^(to\s+|[a-z]*e\s+|[a-z]*ing\s+|[A-Z].*?:)/.test(context) || /\b(to|must|should|can)\b/.test(context)) {
          matches.push({
            phrase: match[0],
            matchedText: textContent.text.substring(match.index, match.index + match[0].length)
          });
        }
      }

      // Convert matches back to line numbers
      for (const m of matches) {
        const lineNum = lineOf(file.content, m.matchedText);
        const key = `${file.path}|${lineNum}|${m.phrase}`;

        if (!seen.has(key)) {
          seen.add(key);
          violations.push({
            file: file.path,
            line: lineNum,
            column: null,
            snippet: snippet(file.content, lineNum),
            message: `Text uses color as the sole means of conveying information: "${m.phrase}". Use additional visual cues (labels, icons, text patterns) to identify elements beyond color alone.`,
            severity: 'moderate',
            criterion: '1.4.1'
          ,
              confidence: 'heuristic'
            });
        }
      }
    }

    return violations;
  }
};

/**
 * Extract text from HTML, excluding <code> and <pre> elements
 */
function extractTextExcludingCode($, body) {
  let text = '';

  body.contents().each((i, node) => {
    if (node.type === 'text') {
      text += node.data + ' ';
    } else if (node.type === 'tag' && node.name !== 'code' && node.name !== 'pre') {
      const child = $(node);
      const result = extractTextExcludingCode($, child);
      text += result.text;
    }
  });

  return { text };
}
