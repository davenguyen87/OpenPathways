/**
 * 3.3.8 Accessible authentication (minimum)
 * Flag authentication forms requiring cognitive function tests without alternatives.
 */

const { lineOf } = require('../lib/line-of');
const { snippet } = require('../lib/snippet');

module.exports = {
  id: '3.3.8',
  name: 'Accessible authentication (minimum)',
  level: 'AA',
  wcagIntroduced: '2.2',
  url: 'https://www.w3.org/WAI/WCAG22/Understanding/accessible-authentication-minimum',

  async run(ctx) {
    const violations = [];
    const seen = new Set();

    // Check for password fields without autocomplete
    for (const file of ctx.files.html) {
      const $ = file.$();

      $('input[type="password"]').each((i, el) => {
        const $input = $(el);
        const autocomplete = $input.attr('autocomplete') || '';

        // Check if autocomplete is set to current-password or new-password
        const hasProperAutocomplete =
          autocomplete === 'current-password' ||
          autocomplete === 'new-password';

        if (!hasProperAutocomplete) {
          const sourceSnippet = $.html(el);
          const line = lineOf(file.content, sourceSnippet);
          const key = `${file.path}|${line}|password-autocomplete`;

          if (!seen.has(key)) {
            seen.add(key);
            violations.push({
              file: file.path,
              line,
              column: null,
              snippet: snippet(file.content, line),
              message:
                'Password field without autocomplete attribute blocks password managers, forcing users to memorize passwords. Add autocomplete="current-password" or autocomplete="new-password".',
              severity: 'serious',
              criterion: '3.3.8'
            ,
              confidence: 'heuristic'
            });
          }
        }
      });

      // Check for CAPTCHA without accessible alternative
      $('img').each((i, el) => {
        const $img = $(el);
        const src = $img.attr('src') || '';
        const classes = $img.attr('class') || '';

        // Heuristic: image src or class contains 'captcha'
        if (!/captcha/i.test(src + classes)) return;

        // Check for audio alternative
        const audioEl = $img.closest('form').find('audio');
        const hasAudioAlt = audioEl.length > 0;

        // Check for "I'm not a robot" checkbox
        let hasCheckboxAlt = false;
        const form = $img.closest('form');
        form.find('input[type="checkbox"]').each((j, chkEl) => {
          const $chk = $(chkEl);
          const label = $chk.closest('label');
          const text = (label.text() || '').toLowerCase();
          if (/not a robot|i am human/i.test(text)) {
            hasCheckboxAlt = true;
            return false;
          }
        });

        if (!hasAudioAlt && !hasCheckboxAlt) {
          const sourceSnippet = $.html(el);
          const line = lineOf(file.content, sourceSnippet);
          const key = `${file.path}|${line}|captcha`;

          if (!seen.has(key)) {
            seen.add(key);
            violations.push({
              file: file.path,
              line,
              column: null,
              snippet: snippet(file.content, line),
              message:
                'CAPTCHA detected without an object-recognition or audio alternative. Provide an audio version or object-recognition option for accessibility.',
              severity: 'serious',
              criterion: '3.3.8'
            ,
              confidence: 'heuristic'
            });
          }
        }
      });

      // Check for reCAPTCHA, hCaptcha, Turnstile script tags
      $('script').each((i, el) => {
        const $script = $(el);
        const src = $script.attr('src') || '';
        const content = $script.text() || '';

        if (!/recaptcha|hcaptcha|turnstile/i.test(src + content)) return;

        // Check for audio alternative in the document
        const audioEl = $('audio');
        const hasAudioAlt = audioEl.length > 0;

        // Check for "I'm not a robot" checkbox
        let hasCheckboxAlt = false;
        $('input[type="checkbox"]').each((j, chkEl) => {
          const $chk = $(chkEl);
          const label = $chk.closest('label');
          const text = (label.text() || '').toLowerCase();
          if (/not a robot|i am human/i.test(text)) {
            hasCheckboxAlt = true;
            return false;
          }
        });

        if (!hasAudioAlt && !hasCheckboxAlt) {
          const sourceSnippet = $.html(el).substring(0, 100);
          const line = lineOf(file.content, sourceSnippet);
          const key = `${file.path}|${line}|captcha-script`;

          if (!seen.has(key)) {
            seen.add(key);
            violations.push({
              file: file.path,
              line,
              column: null,
              snippet: snippet(file.content, line),
              message:
                'CAPTCHA detected without an object-recognition or audio alternative. Provide an audio version or object-recognition option for accessibility.',
              severity: 'serious',
              criterion: '3.3.8'
            ,
              confidence: 'heuristic'
            });
          }
        }
      });
    }

    return violations;
  }
};
