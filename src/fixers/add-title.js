/**
 * Add <title> element when missing or empty.
 */

const { buildPatch, revertPatch, applyMods } = require('../rebuild/types');

const FIXER_ID = 'add-title';
const CRITERION = '2.4.2';
const DEFAULT_TITLE = 'Untitled Course';

module.exports = {
  id: FIXER_ID,
  name: 'Add <title> element',
  supported: ['scorm12', 'scorm2004', 'aicc'],
  confidence: 'definitive',
  criterion: CRITERION,
  triage: 'auto-fix safe',
  tier: 'safe',
  provenance: 'deterministic',

  canFix(file /* , violation */) {
    if (!file.isHtml) return false;

    const titleMatch = file.content.match(/<title[^>]*>(.*?)<\/title>/i);
    if (!titleMatch) return true;
    return titleMatch[1].trim().length === 0;
  },

  async apply(file /* , violations */) {
    const original = file.content;
    const log = [];

    const titleRegex = /<title[^>]*>(.*?)<\/title>/i;
    const titleMatch = titleRegex.exec(original);
    if (titleMatch) {
      const fullTitle = titleMatch[0];
      const newTitle = `<title>${DEFAULT_TITLE}</title>`;
      if (fullTitle === newTitle) {
        log.push('<title> already populated');
        return { changed: false, newContent: original, patches: [], log };
      }

      const patch = buildPatch({
        fixer: FIXER_ID,
        criterion: CRITERION,
        confidence: 'definitive',
        file: file.path,
        content: original,
        originalOffset: titleMatch.index,
        originalText: fullTitle,
        replacementText: newTitle,
        rationale: `<title> was empty; defaulted to "${DEFAULT_TITLE}" so the page exposes a name to assistive tech.`
      });

      log.push(`Replaced empty <title> with "${DEFAULT_TITLE}"`);
      return {
        changed: true,
        newContent: applyMods(original, [
          { offset: titleMatch.index, originalText: fullTitle, replacementText: newTitle }
        ]),
        patches: [patch],
        log
      };
    }

    const headRegex = /<head[^>]*>/i;
    const headMatch = headRegex.exec(original);
    if (!headMatch) {
      log.push('No <head> tag found; cannot insert <title>');
      return { changed: false, newContent: original, patches: [], log };
    }

    const headTag = headMatch[0];
    const newHead = `${headTag}\n  <title>${DEFAULT_TITLE}</title>`;

    const patch = buildPatch({
      fixer: FIXER_ID,
      criterion: CRITERION,
      confidence: 'definitive',
      file: file.path,
      content: original,
      originalOffset: headMatch.index,
      originalText: headTag,
      replacementText: newHead,
      rationale: `Document had no <title>; inserted "${DEFAULT_TITLE}" inside <head> so the page exposes a name to assistive tech.`
    });

    log.push(`Inserted <title>${DEFAULT_TITLE}</title> into <head>`);
    return {
      changed: true,
      newContent: applyMods(original, [
        { offset: headMatch.index, originalText: headTag, replacementText: newHead }
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
