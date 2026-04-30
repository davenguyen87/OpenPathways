/**
 * 1.4.2 Audio control
 * Flags <audio autoplay> without muted, and <video autoplay> without muted.
 * Also scans JS for programmatic play() calls in autoplay handlers.
 */

const { lineOf } = require('../lib/line-of');
const { snippet } = require('../lib/snippet');

module.exports = {
  id: '1.4.2',
  name: 'Audio control',
  level: 'A',
  wcagIntroduced: '2.0',
  url: 'https://www.w3.org/WAI/WCAG22/Understanding/audio-control',

  async run(ctx) {
    const violations = [];
    const seen = new Set();

    // Check HTML for <audio autoplay> and <video autoplay>
    for (const file of ctx.files.html) {
      const $ = file.$();

      // Check <audio> elements
      $('audio[autoplay]').each((i, el) => {
        const $audio = $(el);
        const muted = $audio.attr('muted');
        const controls = $audio.attr('controls');

        // Flag if autoplay is present, not muted, and controls not visible
        if (typeof muted === 'undefined' && !controls) {
          const sourceSnippet = $.html(el);
          const line = lineOf(file.content, sourceSnippet);
          const key = `${file.path}|${line}|audio-autoplay`;

          if (!seen.has(key)) {
            seen.add(key);
            violations.push({
              file: file.path,
              line,
              column: null,
              snippet: snippet(file.content, line),
              message:
                'Audio autoplays without muted attribute and without visible controls. Either add muted attribute, add controls attribute for pause/volume control, or remove autoplay.',
              severity: 'serious',
              criterion: '1.4.2'
            ,
              confidence: 'heuristic'
            });
          }
        }
      });

      // Check <video> elements
      $('video[autoplay]').each((i, el) => {
        const $video = $(el);
        const muted = $video.attr('muted');
        const controls = $video.attr('controls');

        // Flag if autoplay is present, not muted, and controls not visible
        if (typeof muted === 'undefined' && !controls) {
          const sourceSnippet = $.html(el);
          const line = lineOf(file.content, sourceSnippet);
          const key = `${file.path}|${line}|video-autoplay`;

          if (!seen.has(key)) {
            seen.add(key);
            violations.push({
              file: file.path,
              line,
              column: null,
              snippet: snippet(file.content, line),
              message:
                'Video autoplays without muted attribute and without visible controls. Either add muted attribute, add controls attribute for pause/volume control, or remove autoplay.',
              severity: 'serious',
              criterion: '1.4.2'
            ,
              confidence: 'heuristic'
            });
          }
        }
      });
    }

    // Check JS files for programmatic play() calls in autoplay handlers
    for (const file of ctx.files.js) {
      const content = file.content;

      // Pattern: play() calls in window.onload or DOMContentLoaded handlers
      const playInLoadPattern = /(?:window\.onload|addEventListener\s*\(\s*['"]DOMContentLoaded['"]\s*,\s*function|addEventListener\s*\(\s*['"]load['"]\s*,\s*function)[^}]*?\.play\s*\(\s*\)/gs;

      let match;
      while ((match = playInLoadPattern.exec(content)) !== null) {
        const line = lineOf(content, match[0]);
        const key = `${file.path}|${line}|play-handler`;

        if (!seen.has(key)) {
          seen.add(key);
          violations.push({
            file: file.path,
            line,
            column: null,
            snippet: snippet(content, line),
            message:
              'Programmatic media.play() call detected in page load handler. This may trigger autoplay without user interaction. Verify that autoplay is muted or requires user gesture.',
            severity: 'moderate',
            criterion: '1.4.2'
          ,
              confidence: 'heuristic'
            });
        }
      }
    }

    return violations;
  }
};
