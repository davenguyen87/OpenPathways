/**
 * Add tabindex="0" to interactive elements with keyboard handlers.
 */

const { buildPatch, revertPatch, applyMods } = require('../rebuild/types');

const FIXER_ID = 'add-tabindex-keyboard';
const CRITERION = '2.1.1';

module.exports = {
  id: FIXER_ID,
  name: 'Add tabindex="0" to keyboard-aware elements',
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
    const hasKeyHandler = /on(keydown|keyup|keypress)/i.test(snippet);
    const hasTabindex = /tabindex\s*=/i.test(snippet);
    const hasOnclick = /onclick\s*=/i.test(snippet);
    const hasButtonRole = /role\s*=\s*["'](button|link)["']/i.test(snippet);
    return hasKeyHandler && !hasTabindex && (hasOnclick || hasButtonRole);
  },

  async apply(file, violations) {
    const log = [];
    const patches = [];
    const original = file.content;
    const usedOffsets = new Set();
    const mods = [];

    for (const violation of violations) {
      const snippet = violation.snippet || '';
      const line = violation.line || null;

      const tagMatch = snippet.match(/<(\w+)[^>]*>/);
      if (!tagMatch) {
        log.push(`Could not extract tag name from snippet on line ${line}`);
        continue;
      }
      const tagName = tagMatch[1].toLowerCase();

      const elementRegex = new RegExp(
        `<${tagName}[^>]*(?:onclick|onkeydown|onkeyup|onkeypress)[^>]*>`,
        'gi'
      );
      let match;
      let found = false;

      // eslint-disable-next-line no-cond-assign
      while ((match = elementRegex.exec(original)) !== null) {
        if (usedOffsets.has(match.index)) continue;
        const fullTag = match[0];
        if (/\stabindex\s*=/i.test(fullTag)) continue;

        if (snippet.length > 0 && fullTag.includes(snippet.substring(0, 30))) {
          const newTag = fullTag.replace(/>$/, ' tabindex="0">');

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
              rationale: `<${tagName}> had keyboard handlers but no tabindex; added tabindex="0" so keyboard users can focus it.`
            })
          );
          mods.push({ offset: match.index, originalText: fullTag, replacementText: newTag });
          usedOffsets.add(match.index);
          log.push(`Added tabindex="0" to <${tagName}> at position ${match.index}`);
          found = true;
          break;
        }
      }

      if (!found) {
        log.push(`Could not locate matching <${tagName || '?'}> for line ${line}`);
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
