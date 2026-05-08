/**
 * Add title attribute to <iframe> elements.
 */

const { buildPatch, revertPatch, applyMods } = require('../rebuild/types');

const FIXER_ID = 'add-iframe-title';
const CRITERION = '4.1.2';

module.exports = {
  id: FIXER_ID,
  name: 'Add title attribute to <iframe>',
  supported: ['scorm12', 'scorm2004', 'aicc', 'xapi', 'cmi5'],
  confidence: 'definitive',
  criterion: CRITERION,
  triage: 'auto-fix safe',
  tier: 'safe',
  provenance: 'deterministic',

  canFix(file /* , violation */) {
    if (!file.isHtml) return false;

    const iframeRegex = /<iframe[^>]*>/gi;
    let match;
    // eslint-disable-next-line no-cond-assign
    while ((match = iframeRegex.exec(file.content)) !== null) {
      if (!/\stitle\s*=/i.test(match[0])) return true;
    }
    return false;
  },

  async apply(file /* , violations */) {
    const original = file.content;
    const log = [];
    const patches = [];
    const mods = [];

    const iframeRegex = /<iframe([^>]*?)>/gi;
    let match;

    // eslint-disable-next-line no-cond-assign
    while ((match = iframeRegex.exec(original)) !== null) {
      const fullTag = match[0];
      const attrs = match[1];
      if (/\stitle\s*=/i.test(attrs)) continue;

      const titleValue = computeTitleFromAttrs(attrs);
      const newTag = fullTag.replace(/>\s*$/, ` title="${titleValue}">`);

      patches.push(
        buildPatch({
          fixer: FIXER_ID,
          criterion: CRITERION,
          confidence: 'definitive',
          file: file.path,
          content: original,
          originalOffset: match.index,
          originalText: fullTag,
          replacementText: newTag,
          rationale: `<iframe> had no title attribute; injected "${titleValue}" so screen readers announce the embed.`
        })
      );
      mods.push({ offset: match.index, originalText: fullTag, replacementText: newTag });
      log.push(`Added title="${titleValue}" to <iframe> at position ${match.index}`);
    }

    return {
      changed: patches.length > 0,
      newContent: applyMods(original, mods),
      patches,
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

function computeTitleFromAttrs(attrs) {
  const srcMatch = /\ssrc\s*=\s*["']([^"']+)["']/i.exec(attrs);
  if (!srcMatch) return 'Embedded content';
  const srcUrl = srcMatch[1];
  try {
    if (srcUrl.includes('://')) {
      const url = new URL(srcUrl);
      const hostname = url.hostname.replace(/^www\./, '');
      return `Embedded ${hostname} content`;
    }
    if (srcUrl.startsWith('/') || srcUrl.includes('.')) {
      const lastSegment = srcUrl.split('/').pop().split('.')[0];
      if (lastSegment && lastSegment.length > 0) {
        return `Embedded ${lastSegment} content`;
      }
    }
  } catch (_err) {
    /* fallthrough to default */
  }
  return 'Embedded content';
}
