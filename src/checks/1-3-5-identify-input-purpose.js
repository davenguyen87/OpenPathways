/**
 * 1.3.5 Identify Input Purpose
 * Detects input fields collecting personal data without a valid autocomplete attribute.
 */

const { lineOf } = require('../lib/line-of');
const { snippet } = require('../lib/snippet');

// Valid autocomplete input purposes per WCAG 2.2
const VALID_AUTOCOMPLETE_VALUES = new Set([
  'name',
  'honorific-prefix',
  'given-name',
  'additional-name',
  'family-name',
  'honorific-suffix',
  'nickname',
  'email',
  'username',
  'new-password',
  'current-password',
  'one-time-code',
  'organization-title',
  'organization',
  'street-address',
  'address-line1',
  'address-line2',
  'address-line3',
  'address-level4',
  'address-level3',
  'address-level2',
  'address-level1',
  'country',
  'country-name',
  'postal-code',
  'cc-name',
  'cc-given-name',
  'cc-additional-name',
  'cc-family-name',
  'cc-number',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
  'cc-csc',
  'cc-type',
  'transaction-currency',
  'transaction-amount',
  'language',
  'bday',
  'bday-day',
  'bday-month',
  'bday-year',
  'sex',
  'tel',
  'tel-country-code',
  'tel-national',
  'tel-area-code',
  'tel-local',
  'tel-extension',
  'impp',
  'url',
  'photo'
]);

// Personal data signals in name or id attributes
const PERSONAL_DATA_REGEX =
  /\b(name|fname|firstname|lname|lastname|fullname|email|tel|phone|mobile|address|street|city|zip|postal|country|bday|birthday)\b/i;

module.exports = {
  id: '1.3.5',
  name: 'Identify input purpose',
  level: 'AA',
  wcagIntroduced: '2.1',
  url: 'https://www.w3.org/WAI/WCAG22/Understanding/identify-input-purpose',

  async run(ctx) {
    const violations = [];
    const seen = new Set();

    for (const file of ctx.files.html) {
      const $ = file.$();

      $('input').each((i, el) => {
        const $input = $(el);
        const type = ($input.attr('type') || '').toLowerCase();

        // Skip non-text-like input types
        if (
          ['hidden', 'button', 'submit', 'reset', 'image', 'file', 'checkbox', 'radio'].includes(type)
        ) {
          return;
        }

        const name = $input.attr('name') || '';
        const id = $input.attr('id') || '';
        const identifyText = `${name}|${id}`;

        // Check if name or id matches personal data signals
        if (!PERSONAL_DATA_REGEX.test(identifyText)) {
          return;
        }

        // Check autocomplete attribute
        const autocomplete = ($input.attr('autocomplete') || '').toLowerCase().trim();

        // If no autocomplete, flag violation
        if (!autocomplete) {
          const sourceSnippet = $.html(el);
          const line = lineOf(file.content, sourceSnippet);
          const key = `${file.path}|${line}|input-purpose-missing`;

          if (!seen.has(key)) {
            seen.add(key);
            violations.push({
              file: file.path,
              line,
              column: null,
              snippet: snippet(file.content, line),
              message:
                'Input field collects personal data (name, email, tel, address, etc.) but lacks an autocomplete attribute. Add a valid autocomplete value (e.g., autocomplete="email", autocomplete="given-name") so assistive technology can identify the field purpose.',
              severity: 'moderate',
              criterion: '1.3.5'
            });
          }
          return;
        }

        // Check if autocomplete value is valid
        const parts = autocomplete.split(/\s+/);
        const baseValue = parts[0]; // e.g., "given-name" from "given-name webauthn"

        if (!VALID_AUTOCOMPLETE_VALUES.has(baseValue)) {
          const sourceSnippet = $.html(el);
          const line = lineOf(file.content, sourceSnippet);
          const key = `${file.path}|${line}|input-purpose-invalid`;

          if (!seen.has(key)) {
            seen.add(key);
            violations.push({
              file: file.path,
              line,
              column: null,
              snippet: snippet(file.content, line),
              message:
                `Input field has autocomplete="${autocomplete}" but the value is not in the WCAG 2.2 input purposes list. Use a valid autocomplete value like "email", "tel", "address-line1", "given-name", etc.`,
              severity: 'moderate',
              criterion: '1.3.5'
            });
          }
        }
      });
    }

    return violations;
  }
};
