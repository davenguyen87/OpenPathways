/**
 * 2.5.7 Dragging movements
 * Flag drag interactions without a single-pointer alternative.
 */

const { lineOf } = require('../lib/line-of');
const { snippet } = require('../lib/snippet');

module.exports = {
  id: '2.5.7',
  name: 'Dragging movements',
  level: 'AA',
  wcagIntroduced: '2.2',
  url: 'https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements',

  async run(ctx) {
    const violations = [];
    const seen = new Set();

    // Find drag sites in HTML (draggable attribute, dragstart handler)
    for (const file of ctx.files.html) {
      const $ = file.$();

      // Check for draggable="true"
      $('[draggable="true"]').each((i, el) => {
        const $el = $(el);

        // Check for alternative: click handler on same element
        const onclick = $el.attr('onclick');
        let hasAlternative = !!onclick;

        // Or check for nearby button with sort/move/reorder text
        if (!hasAlternative) {
          $el.find('button, a').each((j, btnEl) => {
            const $btn = $(btnEl);
            const text = $btn.text().toLowerCase();
            const aria = $btn.attr('aria-label') || '';
            if (/sort|move up|move down|reorder/i.test(text + aria)) {
              hasAlternative = true;
              return false;
            }
          });
        }

        if (!hasAlternative) {
          const sourceSnippet = $.html(el);
          const line = lineOf(file.content, sourceSnippet);
          const key = `${file.path}|${line}|draggable`;

          if (!seen.has(key)) {
            seen.add(key);
            violations.push({
              file: file.path,
              line,
              column: null,
              snippet: snippet(file.content, line),
              message:
                'Drag interaction detected with no single-pointer alternative. Provide buttons or click targets that perform the same action.',
              severity: 'serious',
              criterion: '2.5.7'
            ,
              confidence: 'heuristic'
            });
          }
        }
      });

      // Check for dragstart handlers
      $('[ondragstart]').each((i, el) => {
        const $el = $(el);
        const ondragstart = $el.attr('ondragstart');
        const onclick = $el.attr('onclick');
        let hasAlternative = !!onclick;

        if (!hasAlternative) {
          $el.find('button, a').each((j, btnEl) => {
            const $btn = $(btnEl);
            const text = $btn.text().toLowerCase();
            const aria = $btn.attr('aria-label') || '';
            if (/sort|move up|move down|reorder/i.test(text + aria)) {
              hasAlternative = true;
              return false;
            }
          });
        }

        if (!hasAlternative) {
          const sourceSnippet = $.html(el);
          const line = lineOf(file.content, sourceSnippet);
          const key = `${file.path}|${line}|ondragstart`;

          if (!seen.has(key)) {
            seen.add(key);
            violations.push({
              file: file.path,
              line,
              column: null,
              snippet: snippet(file.content, line),
              message:
                'Drag interaction detected with no single-pointer alternative. Provide buttons or click targets that perform the same action.',
              severity: 'serious',
              criterion: '2.5.7'
            ,
              confidence: 'heuristic'
            });
          }
        }
      });
    }

    // Find drag sites in JS (mousedown + mousemove pattern, or addEventListener)
    for (const jsFile of ctx.files.js) {
      // Heuristic: file contains both addEventListener('mousedown' and addEventListener('mousemove'
      const hasMousedown = /addEventListener\(['"]mousedown['"]/.test(jsFile.content);
      const hasMousemove = /addEventListener\(['"]mousemove['"]/.test(jsFile.content);

      if (hasMousedown && hasMousemove) {
        // Flag at first line of JS file (rough heuristic)
        const sourceSnippet = jsFile.content.substring(0, 100);
        const line = lineOf(jsFile.content, sourceSnippet);
        const key = `${jsFile.path}|${line}|drag-pattern`;

        if (!seen.has(key)) {
          seen.add(key);
          violations.push({
            file: jsFile.path,
            line: 1, // Start of file
            column: null,
            snippet: snippet(jsFile.content, 1),
            message:
              'Drag interaction detected with no single-pointer alternative. Provide buttons or click targets that perform the same action.',
            severity: 'serious',
            criterion: '2.5.7'
          ,
              confidence: 'heuristic'
            });
        }
      }
    }

    return violations;
  }
};
