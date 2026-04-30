/**
 * 1.2.1 Audio-only and video-only (prerecorded)
 * Flags <audio> or <video> elements without an accompanying transcript link.
 * For video, marks as moderate severity with clarification that we cannot distinguish video-only.
 */

const { lineOf } = require('../lib/line-of');
const { snippet } = require('../lib/snippet');

module.exports = {
  id: '1.2.1',
  name: 'Audio-only and video-only (prerecorded)',
  level: 'A',
  wcagIntroduced: '2.0',
  url: 'https://www.w3.org/WAI/WCAG22/Understanding/audio-only-and-video-only-prerecorded',

  async run(ctx) {
    const violations = [];
    const seen = new Set();

    for (const file of ctx.files.html) {
      const $ = file.$();
      const content = file.content;

      // Check for <audio> elements
      $('audio').each((i, el) => {
        const $audio = $(el);
        const ariaHidden = $audio.attr('aria-hidden');
        let parent = $audio.parent();
        let isDecorative = ariaHidden === 'true';

        // Check if inside decorative container
        while (parent.length && !isDecorative) {
          const parentAriaHidden = parent.attr('aria-hidden');
          const parentClass = parent.attr('class') || '';
          if (parentAriaHidden === 'true' || parentClass.includes('decorative')) {
            isDecorative = true;
          }
          parent = parent.parent();
        }

        if (!isDecorative) {
          // Look for nearby transcript link (within 200 chars before/after in source)
          const sourceSnippet = $.html(el);
          const elementIndex = content.indexOf(sourceSnippet);
          const startIndex = Math.max(0, elementIndex - 200);
          const endIndex = Math.min(content.length, elementIndex + sourceSnippet.length + 200);
          const contextWindow = content.substring(startIndex, endIndex);

          const hasTranscriptLink = /transcript/i.test(contextWindow);

          if (!hasTranscriptLink) {
            const line = lineOf(content, sourceSnippet);
            const key = `${file.path}|${line}|audio`;

            if (!seen.has(key)) {
              seen.add(key);
              violations.push({
                file: file.path,
                line,
                column: null,
                snippet: snippet(content, line),
                message:
                  'Audio has no nearby transcript link. Provide a text transcript for all prerecorded audio content per WCAG 1.2.1.',
                severity: 'moderate',
                criterion: '1.2.1'
              ,
              confidence: 'heuristic'
            });
            }
          }
        }
      });

      // Check for <video> elements
      $('video').each((i, el) => {
        const $video = $(el);
        const ariaHidden = $video.attr('aria-hidden');
        let parent = $video.parent();
        let isDecorative = ariaHidden === 'true';

        // Check if inside decorative container
        while (parent.length && !isDecorative) {
          const parentAriaHidden = parent.attr('aria-hidden');
          const parentClass = parent.attr('class') || '';
          if (parentAriaHidden === 'true' || parentClass.includes('decorative')) {
            isDecorative = true;
          }
          parent = parent.parent();
        }

        if (!isDecorative) {
          // Check for <track> element
          const hasTrack = $video.find('track').length > 0;

          // Look for nearby transcript link (within 200 chars before/after in source)
          const sourceSnippet = $.html(el);
          const elementIndex = content.indexOf(sourceSnippet);
          const startIndex = Math.max(0, elementIndex - 200);
          const endIndex = Math.min(content.length, elementIndex + sourceSnippet.length + 200);
          const contextWindow = content.substring(startIndex, endIndex);

          const hasTranscriptLink = /transcript/i.test(contextWindow);

          if (!hasTrack && !hasTranscriptLink) {
            const line = lineOf(content, sourceSnippet);
            const key = `${file.path}|${line}|video`;

            if (!seen.has(key)) {
              seen.add(key);
              violations.push({
                file: file.path,
                line,
                column: null,
                snippet: snippet(content, line),
                message:
                  'Video has no captions track and no nearby transcript link. Confirm whether content is video-only and add a transcript or captions per WCAG 1.2.1.',
                severity: 'moderate',
                criterion: '1.2.1'
              ,
              confidence: 'heuristic'
            });
            }
          }
        }
      });
    }

    return violations;
  }
};
