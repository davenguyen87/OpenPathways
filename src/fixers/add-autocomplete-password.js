/**
 * Add autocomplete="current-password" to password inputs.
 */

const { buildPatch, revertPatch, applyMods } = require('../rebuild/types');

const FIXER_ID = 'add-autocomplete-password';
const CRITERION = '3.3.8';

module.exports = {
  id: FIXER_ID,
  name: 'Add autocomplete="current-password" to password inputs',
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
    const isPasswordInput = /type\s*=\s*["']password["']/i.test(snippet);
    const hasAutocomplete = /autocomplete\s*=/i.test(snippet);
    return isPasswordInput && !hasAutocomplete;
  },

  async apply(file, violations) {
    const log = [];
    const patches = [];
    const original = file.content;
    const usedOffsets = new Set();
    const mods = [];

    for (const violation of violations) {
      const snippet = violation.snippet || '';
      const inputRegex = /<input\s+([^>]*?type\s*=\s*["']password["'][^>]*)>/gi;
      let match;
      let found = false;

      // eslint-disable-next-line no-cond-assign
      while ((match = inputRegex.exec(original)) !== null) {
        if (usedOffsets.has(match.index)) continue;
        const fullTag = match[0];
        const attrs = match[1];
        if (/autocomplete\s*=/i.test(attrs)) continue;

        if (snippet.length === 0 || fullTag.includes(snippet.substring(0, 30))) {
          const newTag = fullTag.replace(/(\/?)>\s*$/, ' autocomplete="current-password"$1>');

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
              rationale: 'Password input lacked autocomplete; "current-password" lets password managers autofill correctly.'
            })
          );
          mods.push({ offset: match.index, originalText: fullTag, replacementText: newTag });
          usedOffsets.add(match.index);
          log.push(`Added autocomplete="current-password" to password input at position ${match.index}`);
          found = true;
          break;
        }
      }

      if (!found) {
        log.push(`Could not locate matching password input for line ${violation.line}`);
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
