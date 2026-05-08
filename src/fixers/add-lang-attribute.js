/**
 * Add lang="en" to <html> element.
 */

const { buildPatch, revertPatch, applyMods } = require('../rebuild/types');

const FIXER_ID = 'add-lang-attribute';
const CRITERION = '3.1.1';

module.exports = {
  id: FIXER_ID,
  name: 'Add lang attribute to <html>',
  supported: ['scorm12', 'scorm2004', 'aicc'],
  confidence: 'definitive',
  criterion: CRITERION,
  triage: 'auto-fix safe',
  tier: 'safe',
  provenance: 'deterministic',

  canFix(file /* , violation */) {
    if (!file.isHtml) return false;
    const htmlMatch = file.content.match(/<html[^>]*>/i);
    if (!htmlMatch) return false;
    return !/\slang\s*=/i.test(htmlMatch[0]);
  },

  async apply(file /* , violations */) {
    const original = file.content;
    const log = [];

    const htmlRegex = /<html([^>]*)>/i;
    const match = htmlRegex.exec(original);

    if (!match) {
      log.push('No <html> tag found');
      return { changed: false, newContent: original, patches: [], log };
    }

    const fullTag = match[0];
    const attrs = match[1] || '';
    if (/\slang\s*=/i.test(attrs)) {
      log.push('<html> already has lang attribute');
      return { changed: false, newContent: original, patches: [], log };
    }

    const newTag = fullTag.replace(/>$/, ' lang="en">');

    const patch = buildPatch({
      fixer: FIXER_ID,
      criterion: CRITERION,
      confidence: 'definitive',
      file: file.path,
      content: original,
      originalOffset: match.index,
      originalText: fullTag,
      replacementText: newTag,
      rationale: '<html> had no lang attribute; defaulted to "en" so screen readers can pick a pronunciation profile.'
    });

    log.push('Added lang="en" to <html> tag');

    return {
      changed: true,
      newContent: applyMods(original, [
        { offset: match.index, originalText: fullTag, replacementText: newTag }
      ]),
      patches: [patch],
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
