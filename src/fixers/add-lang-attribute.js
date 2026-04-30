/**
 * Add lang="en" to <html> element
 * Scans all HTML files for missing or empty lang attribute
 */

module.exports = {
  id: 'add-lang-attribute',
  name: 'Add lang attribute to <html>',
  supported: ['scorm12', 'scorm2004', 'aicc'],
  confidence: 'definitive',
  criterion: '3.1.1',

  /**
   * Check if this fixer can repair the violation
   * When called with a violation, check if it's a missing lang issue.
   * When called with violation=null (scan mode), return true for all HTML files.
   * @param {object} file - { path, content, isHtml }
   * @param {object} violation - violation object or null
   * @returns {boolean} true if we can fix this
   */
  canFix(file, violation) {
    if (!file.isHtml) return false;

    // Scan mode: check if <html> lacks lang
    const htmlMatch = file.content.match(/<html[^>]*>/i);
    if (!htmlMatch) return false;

    const htmlTag = htmlMatch[0];
    const hasLang = /\slang\s*=/i.test(htmlTag);

    // Return true if missing lang
    return !hasLang;
  },

  /**
   * Repair the violation by adding lang="en" to <html>
   * @param {object} file - { path, content, isHtml }
   * @param {array} violations - violations this fixer can fix (may be empty for scan mode)
   * @returns {object} { changed: bool, newContent: string, log: [] }
   */
  async fix(file, violations) {
    let newContent = file.content;
    const log = [];

    // Find <html> tag and add lang="en" if missing
    const htmlRegex = /<html([^>]*)>/i;
    const match = newContent.match(htmlRegex);

    if (!match) {
      log.push('No <html> tag found');
      return { changed: false, newContent, log };
    }

    const htmlTag = match[0];
    const attrs = match[1] || '';

    // Check if already has lang
    if (/\slang\s*=/i.test(attrs)) {
      log.push('<html> already has lang attribute');
      return { changed: false, newContent, log };
    }

    // Insert lang="en" before the closing >
    const newTag = htmlTag.replace(/>$/, ' lang="en">');
    newContent = newContent.replace(htmlTag, newTag);
    log.push('Added lang="en" to <html> tag');

    return { changed: true, newContent, log };
  }
};
