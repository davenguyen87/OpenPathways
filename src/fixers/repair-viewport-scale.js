/**
 * Repair viewport meta tag to allow user scaling.
 */

const { buildPatch, revertPatch, applyMods } = require('../rebuild/types');

const FIXER_ID = 'repair-viewport-scale';
const CRITERION = '1.4.4';
const SAFE_VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1.0">';

module.exports = {
  id: FIXER_ID,
  name: 'Repair viewport meta tag to allow user scaling',
  supported: ['scorm12', 'scorm2004', 'aicc'],
  confidence: 'definitive',
  criterion: CRITERION,
  triage: 'auto-fix safe',
  tier: 'safe',
  provenance: 'deterministic',

  canFix(file, violation) {
    if (violation === null || violation === undefined) return false;
    if (violation.criterion !== CRITERION) return false;
    if (!file.isHtml) return false;

    const snippet = violation.snippet || '';
    const hasNoScale = /user-scalable\s*=\s*(no|0)/i.test(snippet);
    const hasLowMaxScale = /maximum-scale\s*=\s*[\d.]*1(?:\.0)?\b/i.test(snippet);
    return hasNoScale || hasLowMaxScale;
  },

  async apply(file, violations) {
    const log = [];
    const patches = [];
    const original = file.content;
    const usedOffsets = new Set();
    const mods = [];

    for (const violation of violations) {
      const viewportRegex = /<meta\s+name\s*=\s*["']viewport["'][^>]*>/gi;
      let match;
      let found = false;

      // eslint-disable-next-line no-cond-assign
      while ((match = viewportRegex.exec(original)) !== null) {
        if (usedOffsets.has(match.index)) continue;
        const fullTag = match[0];
        const contentMatch = fullTag.match(/content\s*=\s*["']([^"']*)["']/i);
        if (!contentMatch) continue;
        const metaContent = contentMatch[1];

        const hasNoScale = /user-scalable\s*=\s*(no|0)/i.test(metaContent);
        const hasLowMaxScale = /maximum-scale\s*=\s*[\d.]*1(?:\.0)?\b/i.test(metaContent);
        if (!hasNoScale && !hasLowMaxScale) continue;

        patches.push(
          buildPatch({
            fixer: FIXER_ID,
            criterion: CRITERION,
            confidence: 'definitive',
            file: file.path,
            content: original,
            originalOffset: match.index,
            originalText: fullTag,
            replacementText: SAFE_VIEWPORT,
            rationale: 'Viewport meta blocked user scaling; replaced with width=device-width + initial-scale=1.0 so users can pinch-zoom.'
          })
        );
        mods.push({ offset: match.index, originalText: fullTag, replacementText: SAFE_VIEWPORT });
        usedOffsets.add(match.index);
        log.push(`Replaced viewport meta with safe scaling settings at position ${match.index}`);
        found = true;
        break;
      }

      if (!found) {
        log.push(`Could not locate viewport meta tag for line ${violation.line}`);
      }
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
