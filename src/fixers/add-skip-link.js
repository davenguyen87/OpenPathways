/**
 * Add a keyboard-accessible skip-to-main-content link.
 * Inserts a visually hidden but keyboard-focusable skip link after <body>.
 */

const { buildPatch, revertPatch, applyMods } = require('../rebuild/types');

const FIXER_ID = 'add-skip-link';

const SKIP_LINK_HTML =
  '\n    <a href="#main-content" class="skip-link" style="position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden;">Skip to main content</a>';

module.exports = {
  id: FIXER_ID,
  name: 'Add skip-to-main-content link',
  supported: ['scorm12', 'scorm2004', 'aicc', 'xapi', 'cmi5'],
  confidence: 'needs-review',
  criterion: '',
  triage: 'auto-fix safe',
  tier: 'safe',
  provenance: 'deterministic',

  canFix(file, violation) {
    if (!file.isHtml) return false;
    if (violation !== null) return false;

    const bodyMatch = file.content.match(/<body[^>]*>/i);
    if (!bodyMatch) return false;

    const bodyStart = file.content.indexOf(bodyMatch[0]) + bodyMatch[0].length;
    const afterBody = file.content.substring(bodyStart, bodyStart + 500);
    if (/href\s*=\s*["']#[a-z-]*main[a-z-]*["']/i.test(afterBody)) return false;

    return true;
  },

  async apply(file /* , violations */) {
    const original = file.content;
    const log = [];

    const bodyRegex = /<body[^>]*>/i;
    const match = bodyRegex.exec(original);
    if (!match) {
      log.push('No <body> tag found');
      return { changed: false, newContent: original, patches: [], log };
    }

    const bodyTag = match[0];
    const newBody = `${bodyTag}${SKIP_LINK_HTML}`;

    const patch = buildPatch({
      fixer: FIXER_ID,
      criterion: '',
      confidence: 'needs-review',
      file: file.path,
      content: original,
      originalOffset: match.index,
      originalText: bodyTag,
      replacementText: newBody,
      rationale: 'No keyboard skip link detected near <body>; inserted a visually-hidden, keyboard-focusable link to #main-content.'
    });

    log.push('Added keyboard-accessible skip link after <body>');

    return {
      changed: true,
      newContent: applyMods(original, [
        { offset: match.index, originalText: bodyTag, replacementText: newBody }
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
