/**
 * Add alt="" to decorative images.
 * Detects clearly decorative images and adds alt="" to silence screen readers.
 */

const { buildPatch, revertPatch, applyMods } = require('../rebuild/types');

const FIXER_ID = 'add-alt-decorative';
const CRITERION = '1.1.1';

module.exports = {
  id: FIXER_ID,
  name: 'Add alt="" to decorative images',
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

    const msg = violation.message || '';
    const snippet = violation.snippet || '';
    const combined = `${msg}|${snippet}`.toLowerCase();

    if (/role\s*=\s*["']?presentation["']?/i.test(combined)) return true;
    if (/spacer|divider|bullet|pixel|blank|transparent|icon-small|decoration/i.test(combined)) {
      return true;
    }
    return false;
  },

  async apply(file, violations) {
    const log = [];
    const patches = [];
    const original = file.content;
    const usedOffsets = new Set();
    const mods = [];

    for (const violation of violations) {
      const snippet = violation.snippet || '';
      const imgRegex = /<img\s+([^>]*?)>/gi;
      let match;
      let found = false;

      // eslint-disable-next-line no-cond-assign
      while ((match = imgRegex.exec(original)) !== null) {
        if (usedOffsets.has(match.index)) continue;
        const fullTag = match[0];
        const attrs = match[1];
        if (/\salt\s*=/i.test(attrs)) continue;

        if (
          snippet.includes(fullTag.substring(0, 50)) ||
          /role\s*=\s*["']presentation["']/i.test(attrs) ||
          /spacer|divider|bullet|pixel|blank|transparent|decoration/i.test(attrs)
        ) {
          const newTag = fullTag.replace(/\s*\/?>\s*$/, ' alt="" />');
          const rationale = /role\s*=\s*["']presentation["']/i.test(attrs)
            ? 'role="presentation" indicates a decorative image; silenced for screen readers via alt="".'
            : 'Decorative filename pattern indicates a non-informative image; silenced for screen readers via alt="".';

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
              rationale
            })
          );
          mods.push({ offset: match.index, originalText: fullTag, replacementText: newTag });
          usedOffsets.add(match.index);
          log.push(`Added alt="" to <img> at position ${match.index}`);
          found = true;
          break;
        }
      }

      if (!found) {
        log.push(`Could not locate matching <img> for line ${violation.line}`);
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
