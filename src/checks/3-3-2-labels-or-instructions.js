/**
 * 3.3.2 Labels or instructions
 * Flag form inputs without associated labels, aria-label, aria-labelledby, or title.
 */

const { lineOf } = require('../lib/line-of');
const { snippet } = require('../lib/snippet');

module.exports = {
  id: '3.3.2',
  name: 'Labels or instructions',
  level: 'A',
  wcagIntroduced: '2.0',
  url: 'https://www.w3.org/WAI/WCAG22/Understanding/labels-or-instructions',

  async run(ctx) {
    const violations = [];
    const seen = new Set();

    for (const file of ctx.files.html) {
      const $ = file.$();

      // Check <input> elements (exclude type hidden, submit, reset, button, image)
      $('input').each((i, el) => {
        const $input = $(el);
        const type = $input.attr('type') || 'text';
        const excludedTypes = new Set([
          'hidden',
          'submit',
          'reset',
          'button',
          'image'
        ]);

        if (excludedTypes.has(type.toLowerCase())) return;

        // Check for label
        const inputId = $input.attr('id');
        const ariaLabel = $input.attr('aria-label');
        const ariaLabelledby = $input.attr('aria-labelledby');
        const title = $input.attr('title');

        let hasLabel = ariaLabel || ariaLabelledby || title;

        // Check for <label for="...">
        if (!hasLabel && inputId) {
          const label = $(`label[for="${inputId}"]`);
          if (label.length > 0) {
            hasLabel = true;
          }
        }

        // Check for parent <label> wrapping
        if (!hasLabel) {
          const parent = $input.parent();
          if (parent.length > 0 && parent[0].name === 'label') {
            hasLabel = true;
          }
        }

        if (!hasLabel) {
          const required = $input.attr('required');
          const ariaRequired = $input.attr('aria-required');
          const isRequired = typeof required !== 'undefined' || ariaRequired === 'true';

          const sourceSnippet = $.html(el);
          const line = lineOf(file.content, sourceSnippet);
          const key = `${file.path}|${line}|${sourceSnippet}`;

          if (!seen.has(key)) {
            seen.add(key);
            violations.push({
              file: file.path,
              line,
              column: null,
              snippet: snippet(file.content, line),
              message:
                'Form input lacks a label. Associate a <label for="id">, add aria-label, aria-labelledby, or title attribute so screen readers can announce the input\'s purpose.',
              severity: isRequired ? 'critical' : 'serious',
              criterion: '3.3.2'
            });
          }
        }
      });

      // Check <select> elements
      $('select').each((i, el) => {
        const $select = $(el);
        const selectId = $select.attr('id');
        const ariaLabel = $select.attr('aria-label');
        const ariaLabelledby = $select.attr('aria-labelledby');
        const title = $select.attr('title');

        let hasLabel = ariaLabel || ariaLabelledby || title;

        if (!hasLabel && selectId) {
          const label = $(`label[for="${selectId}"]`);
          if (label.length > 0) hasLabel = true;
        }

        if (!hasLabel) {
          const parent = $select.parent();
          if (parent.length > 0 && parent[0].name === 'label') hasLabel = true;
        }

        if (!hasLabel) {
          const required = $select.attr('required');
          const ariaRequired = $select.attr('aria-required');
          const isRequired = typeof required !== 'undefined' || ariaRequired === 'true';

          const sourceSnippet = $.html(el);
          const line = lineOf(file.content, sourceSnippet);
          const key = `${file.path}|${line}|${sourceSnippet}`;

          if (!seen.has(key)) {
            seen.add(key);
            violations.push({
              file: file.path,
              line,
              column: null,
              snippet: snippet(file.content, line),
              message:
                'Select element lacks a label. Associate a <label for="id">, add aria-label, aria-labelledby, or title attribute so screen readers can announce its purpose.',
              severity: isRequired ? 'critical' : 'serious',
              criterion: '3.3.2'
            });
          }
        }
      });

      // Check <textarea> elements
      $('textarea').each((i, el) => {
        const $textarea = $(el);
        const textareaId = $textarea.attr('id');
        const ariaLabel = $textarea.attr('aria-label');
        const ariaLabelledby = $textarea.attr('aria-labelledby');
        const title = $textarea.attr('title');

        let hasLabel = ariaLabel || ariaLabelledby || title;

        if (!hasLabel && textareaId) {
          const label = $(`label[for="${textareaId}"]`);
          if (label.length > 0) hasLabel = true;
        }

        if (!hasLabel) {
          const parent = $textarea.parent();
          if (parent.length > 0 && parent[0].name === 'label') hasLabel = true;
        }

        if (!hasLabel) {
          const required = $textarea.attr('required');
          const ariaRequired = $textarea.attr('aria-required');
          const isRequired = typeof required !== 'undefined' || ariaRequired === 'true';

          const sourceSnippet = $.html(el);
          const line = lineOf(file.content, sourceSnippet);
          const key = `${file.path}|${line}|${sourceSnippet}`;

          if (!seen.has(key)) {
            seen.add(key);
            violations.push({
              file: file.path,
              line,
              column: null,
              snippet: snippet(file.content, line),
              message:
                'Textarea lacks a label. Associate a <label for="id">, add aria-label, aria-labelledby, or title attribute so screen readers can announce its purpose.',
              severity: isRequired ? 'critical' : 'serious',
              criterion: '3.3.2'
            });
          }
        }
      });
    }

    return violations;
  }
};
