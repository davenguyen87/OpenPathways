/**
 * 1.2.2 Captions (prerecorded)
 * Flags <video> elements without a <track kind="captions"> or <track kind="subtitles">
 */

const { lineOf } = require('../lib/line-of');
const { snippet } = require('../lib/snippet');

module.exports = {
  id: '1.2.2',
  name: 'Captions (prerecorded)',
  level: 'A',
  wcagIntroduced: '2.0',
  url: 'https://www.w3.org/WAI/WCAG22/Understanding/captions-prerecorded',

  async run(ctx) {
    const violations = [];
    const seen = new Set();

    for (const file of ctx.files.html) {
      const $ = file.$();

      $('video').each((i, el) => {
        const $video = $(el);
        const ariaHidden = $video.attr('aria-hidden');

        // Skip if aria-hidden="true" or inside aria-hidden ancestor
        if (ariaHidden === 'true') {
          return;
        }

        let parent = $video.parent();
        let insideHidden = false;
        while (parent.length) {
          if (parent.attr('aria-hidden') === 'true') {
            insideHidden = true;
            break;
          }
          parent = parent.parent();
        }

        if (insideHidden) {
          return;
        }

        // Check for captions or subtitles track
        const hasCaptions = $video.find('track').toArray().some((track) => {
          const kind = $(track).attr('kind') || '';
          return kind === 'captions' || kind === 'subtitles';
        });

        if (!hasCaptions) {
          const sourceSnippet = $.html(el);
          const line = lineOf(file.content, sourceSnippet);
          const key = `${file.path}|${line}|video-captions`;

          if (!seen.has(key)) {
            seen.add(key);
            violations.push({
              file: file.path,
              line,
              column: null,
              snippet: snippet(file.content, line),
              message:
                'Video is missing captions. Add a <track kind="captions"> element with a WebVTT file providing synchronized captions for all dialogue and sound effects.',
              severity: 'serious',
              criterion: '1.2.2'
            });
          }
        }
      });
    }

    return violations;
  }
};
