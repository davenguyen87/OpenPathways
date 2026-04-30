/**
 * Add keyboard-accessible skip-to-main-content link
 * Inserts a visually hidden but keyboard-focusable skip link after <body>
 */

module.exports = {
  id: 'add-skip-link',
  name: 'Add skip-to-main-content link',
  supported: ['scorm12', 'scorm2004', 'aicc', 'xapi', 'cmi5'],
  confidence: 'heuristic',
  criterion: '',

  /**
   * Check if this fixer can add a skip link
   * When violation is provided, return false (no specific violation maps to this).
   * When violation is null (scan mode), check if file has body but no skip link.
   * @param {object} file - { path, content, isHtml }
   * @param {object} violation - violation object or null
   * @returns {boolean} true if we can fix this
   */
  canFix(file, violation) {
    if (!file.isHtml) return false;

    // Don't act on specific violations; only scan mode
    if (violation !== null) return false;

    // Must have a <body> element
    if (!/<body[^>]*>/i.test(file.content)) return false;

    // Check if a skip link already exists in the first 500 chars after <body>
    const bodyMatch = file.content.match(/<body[^>]*>/i);
    if (!bodyMatch) return false;

    const bodyStart = file.content.indexOf(bodyMatch[0]) + bodyMatch[0].length;
    const afterBody = file.content.substring(bodyStart, bodyStart + 500);

    // Check for skip link patterns
    if (/href\s*=\s*["']#[a-z-]*main[a-z-]*["']/i.test(afterBody)) {
      return false; // Skip link already exists
    }

    return true;
  },

  /**
   * Repair by inserting a skip link after <body>
   * @param {object} file - { path, content, isHtml }
   * @param {array} violations - violations this fixer can fix (empty in scan mode)
   * @returns {object} { changed: bool, newContent: string, log: [] }
   */
  async fix(file, violations) {
    let newContent = file.content;
    const log = [];

    // Find <body> tag
    const bodyRegex = /(<body[^>]*>)/i;
    const match = newContent.match(bodyRegex);

    if (!match) {
      log.push('No <body> tag found');
      return { changed: false, newContent, log };
    }

    const bodyTag = match[0];

    // The skip link: visually hidden but keyboard-focusable
    const skipLink = `${bodyTag}
    <a href="#main-content" class="skip-link" style="position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden;">Skip to main content</a>`;

    newContent = newContent.replace(bodyRegex, skipLink);
    log.push('Added keyboard-accessible skip link after <body>');

    return { changed: true, newContent, log };
  }
};
