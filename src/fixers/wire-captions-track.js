/**
 * Wire captions <track> element into <video> elements.
 *
 * Criterion: 1.2.2 — Captions (prerecorded)
 * Triage: auto-fix safe
 *
 * Strategy:
 *   For each `<video>` in the HTML file, look for a matching `.vtt` file:
 *     1. Same directory as the HTML file with a name matching the video's `src`
 *        attribute stem (e.g. `intro.mp4` → `intro.vtt`).
 *     2. A sibling `captions/` directory: `captions/intro.vtt`.
 *
 *   If found, inject `<track kind="captions" src="<vtt-path>" srclang="en" default>`
 *   immediately before the `</video>` closing tag.
 *
 * Decline policy:
 *   - No matching `.vtt` file found → deferred with reason
 *     "no matching .vtt file — captions are content-creation work".
 *   - Any `<track>` already present on the video (any kind) → decline silently
 *     (the author has made a choice; we don't override).
 *   - File is not HTML → canFix returns false.
 *   - `<video>` has no usable `src` attribute and no `<source>` child → we
 *     cannot derive the stem → deferred.
 *
 * Package context:
 *   The fixer needs to know what files are present in the package. Receive this
 *   via `packageContext.siblings` — an array of relative file paths within the
 *   package. If not provided (e.g. tests that construct a simple in-memory
 *   file), the fixer falls back to `file.siblings` on the file object itself.
 *   Both are arrays of strings like `["video/intro.mp4", "video/intro.vtt"]`.
 *
 * Patch shape:
 *   Each patch's originalText is the `</video>` close tag; replacementText is
 *   `<track ...></video>`. This keeps the patch minimal and the round-trip
 *   reliable: revert restores the original close tag.
 */

const cheerio = require('cheerio');
const path = require('path');
const { buildPatch, revertPatch, applyMods } = require('../rebuild/types');

const FIXER_ID = 'wire-captions-track';
const CRITERION = '1.2.2';

/**
 * Derive the video file's stem from its `src` attribute or from the first
 * `<source src="...">` child. Returns null when no src is detectable.
 *
 * @param {Object} videoEl - cheerio element
 * @param {import('cheerio').CheerioAPI} $ - cheerio instance
 * @returns {string|null} stem (e.g. `intro` for `intro.mp4`)
 */
function videoStem(videoEl, $) {
  let src = $(videoEl).attr('src') || '';
  if (!src) {
    const sourceEl = $(videoEl).find('source').first();
    src = sourceEl.attr('src') || '';
  }
  if (!src) return null;
  // Strip query string and hash.
  const clean = src.split('?')[0].split('#')[0];
  const base = clean.split('/').pop();
  const dotIdx = base.lastIndexOf('.');
  if (dotIdx <= 0) return null;
  return base.slice(0, dotIdx);
}

/**
 * Given the HTML file's path and a stem, search `siblings` for a matching
 * `.vtt` file. Returns the shortest path to use as `src` in the `<track>`
 * element, or null if not found.
 *
 * Search order (matches spec):
 *   1. Same directory as the HTML: `<stem>.vtt`
 *   2. Sibling `captions/` directory: `captions/<stem>.vtt`
 *
 * All comparisons are case-insensitive because package authors vary.
 *
 * @param {string} htmlFilePath - e.g. `content/page.html`
 * @param {string} stem
 * @param {string[]} siblings - all package file paths
 * @returns {string|null} relative path from the html file's directory
 */
function findVttPath(htmlFilePath, stem, siblings) {
  if (!siblings || siblings.length === 0) return null;
  const htmlDir = path.dirname(htmlFilePath).replace(/\\/g, '/');
  const stemLow = stem.toLowerCase();

  // Candidate 1: same dir
  const sameDir = htmlDir === '.' ? `${stem}.vtt` : `${htmlDir}/${stem}.vtt`;
  const sameDirLow = sameDir.toLowerCase();
  if (siblings.some((s) => s.replace(/\\/g, '/').toLowerCase() === sameDirLow)) {
    // Return a path relative to the HTML file's directory.
    return `${stem}.vtt`;
  }

  // Candidate 2: sibling captions/ dir
  const captionsDir = htmlDir === '.' ? `captions/${stem}.vtt` : `${htmlDir}/captions/${stem}.vtt`;
  const captionsDirLow = captionsDir.toLowerCase();
  if (siblings.some((s) => s.replace(/\\/g, '/').toLowerCase() === captionsDirLow)) {
    return `captions/${stem}.vtt`;
  }

  // Broader scan: any .vtt file whose basename (without extension) matches stem
  const matchAnywhere = siblings.find((s) => {
    const sn = s.replace(/\\/g, '/');
    const base = sn.split('/').pop();
    const dotIdx = base.lastIndexOf('.');
    return (
      dotIdx > 0 &&
      base.slice(dotIdx + 1).toLowerCase() === 'vtt' &&
      base.slice(0, dotIdx).toLowerCase() === stemLow
    );
  });
  if (matchAnywhere) {
    // Return a relative path from the HTML dir to the vtt file.
    const vttNorm = matchAnywhere.replace(/\\/g, '/');
    if (htmlDir === '.') return vttNorm;
    // Use a relative path: if vttNorm starts with the same dir prefix, strip it.
    if (vttNorm.startsWith(htmlDir + '/')) {
      return vttNorm.slice(htmlDir.length + 1);
    }
    // Otherwise emit the full path relative to package root; browsers can
    // resolve this when the HTML is loaded from the zip root.
    return vttNorm;
  }

  return null;
}

module.exports = {
  id: FIXER_ID,
  name: 'Wire <track kind="captions"> for videos with a matching .vtt file',
  supported: ['scorm12', 'scorm2004', 'aicc'],
  confidence: 'definitive',
  criterion: CRITERION,
  triage: 'auto-fix safe',
  tier: 'safe',
  provenance: 'deterministic',

  canFix(file, violation) {
    if (!file || !file.isHtml) return false;
    if (!violation || violation.criterion !== CRITERION) return false;
    return true;
  },

  /**
   * @param {{ path: string, content: string, isHtml: boolean, siblings?: string[] }} file
   * @param {Array<Object>} violations
   * @param {{ siblings?: string[] }} [packageContext]
   * @returns {Promise<{ changed: boolean, newContent: string, patches: Array, deferred: Array, log: string[] }>}
   */
  async apply(file, violations, packageContext) {
    const log = [];
    const patches = [];
    const deferred = [];

    if (!file || !file.isHtml || typeof file.content !== 'string') {
      return { changed: false, newContent: (file && file.content) || '', patches, deferred, log };
    }

    const siblings =
      (packageContext && packageContext.siblings) ||
      file.siblings ||
      [];

    const original = file.content;
    const mods = [];
    const processedOffsets = new Set();

    let $;
    try {
      $ = cheerio.load(original, { decodeEntities: false });
    } catch (e) {
      log.push(`Could not parse HTML: ${e.message}`);
      return { changed: false, newContent: original, patches, deferred, log };
    }

    // Collect all videos that have 1.2.2 violations.
    const videoEls = $('video').toArray();

    for (const videoEl of videoEls) {
      const $video = $(videoEl);

      // Skip if a <track> already exists (any kind).
      if ($video.find('track').length > 0) {
        log.push(`<video> at already has a <track>; skipping`);
        continue;
      }

      // Get the stem.
      const stem = videoStem(videoEl, $);
      if (!stem) {
        deferred.push({
          criterion: CRITERION,
          triage: 'auto-fix safe',
          reason: 'no matching .vtt file — captions are content-creation work',
          file: file.path,
          line: null
        });
        log.push(`Could not determine stem for <video> in ${file.path}`);
        continue;
      }

      // Find a matching .vtt file.
      const vttPath = findVttPath(file.path, stem, siblings);
      if (!vttPath) {
        deferred.push({
          criterion: CRITERION,
          triage: 'auto-fix safe',
          reason: 'no matching .vtt file — captions are content-creation work',
          file: file.path,
          line: null
        });
        log.push(`No .vtt found for stem "${stem}" in ${file.path}`);
        continue;
      }

      // Locate the </video> close tag in the original source.
      // We need to find the right </video> for this specific video element.
      // Strategy: use the character offset of the video element's open tag,
      // then find the next </video> after it.
      const videoHtml = $.html(videoEl);
      const videoStart = original.indexOf(videoHtml);

      // In case cheerio normalised attributes, fall back to searching for
      // the </video> after the position of the video element's raw open tag.
      let searchStart = videoStart >= 0 ? videoStart : 0;

      // If we already patched an earlier <video> in this loop, avoid reusing
      // the same offset.
      if (processedOffsets.has(searchStart)) {
        // Try to find the next occurrence.
        const next = original.indexOf(videoHtml, searchStart + 1);
        if (next === -1) {
          log.push(`Could not uniquely locate <video> element; skipping`);
          continue;
        }
        searchStart = next;
      }

      // Locate the </video> tag that closes this element.
      const closeRe = /<\/video\s*>/i;
      const tail = original.slice(searchStart);
      const closeMatch = tail.match(closeRe);
      if (!closeMatch) {
        log.push(`No </video> found after offset ${searchStart}; skipping`);
        continue;
      }

      const closeOffset = searchStart + closeMatch.index;

      if (processedOffsets.has(closeOffset)) {
        log.push(`Offset ${closeOffset} already patched; skipping duplicate`);
        continue;
      }
      processedOffsets.add(closeOffset);

      const originalText = closeMatch[0]; // `</video>`
      const trackTag = `<track kind="captions" src="${vttPath}" srclang="en" default>`;
      const replacementText = trackTag + originalText;

      mods.push({ offset: closeOffset, originalText, replacementText });

      patches.push(
        buildPatch({
          fixer: FIXER_ID,
          criterion: CRITERION,
          confidence: 'definitive',
          file: file.path,
          content: original,
          originalOffset: closeOffset,
          originalText,
          replacementText,
          rationale: `Injected <track kind="captions" src="${vttPath}" srclang="en" default> before </video> — .vtt file confirmed present in package.`
        })
      );

      log.push(`Wired captions track ${vttPath} for <video> with stem "${stem}"`);
    }

    return {
      changed: patches.length > 0,
      newContent: applyMods(original, mods),
      patches,
      deferred,
      log
    };
  },

  async revert(file, patch) {
    return revertPatch(file, patch);
  },

  async fix(file, violations) {
    const result = await this.apply(file, violations);
    return { changed: result.changed, newContent: result.newContent, log: result.log };
  }
};
