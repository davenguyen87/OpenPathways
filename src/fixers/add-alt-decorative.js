/**
 * Add alt="" to decorative images
 * Detects clearly decorative images and adds alt="" to silence screen readers
 */

module.exports = {
  id: 'add-alt-decorative',
  name: 'Add alt="" to decorative images',
  supported: ['scorm12', 'scorm2004', 'aicc'],
  confidence: 'definitive',
  criterion: '1.1.1',

  /**
   * Check if this fixer can repair the violation
   * @param {object} file - { path, content, isHtml }
   * @param {object} violation - violation object
   * @returns {boolean} true if we can fix this
   */
  canFix(file, violation) {
    if (violation.criterion !== '1.1.1') return false;
    if (!file.isHtml) return false;

    // Look for decorative signals in the violation message or snippet
    const msg = violation.message || '';
    const snippet = violation.snippet || '';
    const combined = `${msg}|${snippet}`.toLowerCase();

    // Check for role="presentation" in the snippet OR message
    if (/role\s*=\s*["']?presentation["']?/i.test(combined)) {
      return true;
    }

    // Check for decorative filename patterns
    if (/spacer|divider|bullet|pixel|blank|transparent|icon-small|decoration/i.test(combined)) {
      return true;
    }

    return false;
  },

  /**
   * Repair the violation by adding alt="" to the img tag
   * @param {object} file - { path, content, isHtml }
   * @param {array} violations - violations this fixer can fix
   * @returns {object} { changed: bool, newContent: string, log: [] }
   */
  async fix(file, violations) {
    let newContent = file.content;
    const log = [];

    for (const violation of violations) {
      const snippet = violation.snippet || '';

      // Find the <img> tag in the content
      // Look for the exact snippet or a close match
      const imgRegex = /<img\s+([^>]*?)>/gi;
      let match;
      let found = false;

      // eslint-disable-next-line no-cond-assign
      while ((match = imgRegex.exec(newContent)) !== null) {
        const fullTag = match[0];
        const attrs = match[1];

        // Check if this img already has alt
        if (/\salt\s*=/i.test(attrs)) {
          continue; // Skip, already has alt
        }

        // Check if this matches our snippet or is clearly decorative
        if (
          snippet.includes(fullTag.substring(0, 50)) ||
          /role\s*=\s*["']presentation["']/i.test(attrs) ||
          /spacer|divider|bullet|pixel|blank|transparent|decoration/i.test(attrs)
        ) {
          // Insert alt="" before the closing >
          const newTag = fullTag.replace(/>\s*$/, ' alt="" />');
          newContent = newContent.replace(fullTag, newTag);
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
      changed: log.length > 0,
      newContent,
      log
    };
  }
};
