/**
 * Add <title> element when missing or empty
 * Scans all HTML files for missing or blank title tags
 */

module.exports = {
  id: 'add-title',
  name: 'Add <title> element',
  supported: ['scorm12', 'scorm2004', 'aicc'],
  confidence: 'definitive',
  criterion: '2.4.2',

  /**
   * Check if this fixer can repair the violation
   * When called with a violation, check if it's a missing title issue.
   * When called with violation=null (scan mode), return true for all HTML files.
   * @param {object} file - { path, content, isHtml }
   * @param {object} violation - violation object or null
   * @returns {boolean} true if we can fix this
   */
  canFix(file, violation) {
    if (!file.isHtml) return false;

    // Look for <title> element
    const titleMatch = file.content.match(/<title[^>]*>(.*?)<\/title>/i);

    // Return true if missing or empty
    if (!titleMatch) return true; // Missing
    const titleContent = titleMatch[1].trim();
    return titleContent.length === 0; // Empty
  },

  /**
   * Repair the violation by adding or filling <title>
   * @param {object} file - { path, content, isHtml }
   * @param {array} violations - violations this fixer can fix (may be empty for scan mode)
   * @returns {object} { changed: bool, newContent: string, log: [] }
   */
  async fix(file, violations) {
    let newContent = file.content;
    const log = [];

    // Check for existing <title> element
    const titleMatch = newContent.match(/<title[^>]*>(.*?)<\/title>/i);

    if (titleMatch) {
      // Title exists but is empty; replace it
      const oldTitle = titleMatch[0];
      const newTitle = '<title>Untitled Course</title>';
      newContent = newContent.replace(oldTitle, newTitle);
      log.push('Replaced empty <title> with "Untitled Course"');
      return { changed: true, newContent, log };
    }

    // Title is missing; need to insert into <head>
    const headMatch = newContent.match(/<head[^>]*>/i);
    if (!headMatch) {
      log.push('No <head> tag found; cannot insert <title>');
      return { changed: false, newContent, log };
    }

    const headTag = headMatch[0];
    const newHead = `${headTag}\n  <title>Untitled Course</title>`;
    newContent = newContent.replace(headTag, newHead);
    log.push('Inserted <title>Untitled Course</title> into <head>');

    return { changed: true, newContent, log };
  }
};
