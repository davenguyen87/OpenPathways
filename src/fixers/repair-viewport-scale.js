/**
 * Repair viewport meta tag to allow user scaling
 * Detects user-scalable=no or maximum-scale < 2 and fixes them
 */

module.exports = {
  id: 'repair-viewport-scale',
  name: 'Repair viewport meta tag to allow user scaling',
  supported: ['scorm12', 'scorm2004', 'aicc'],
  confidence: 'definitive',
  criterion: '1.4.4',

  /**
   * Check if this fixer can repair the violation
   * @param {object} file - { path, content, isHtml }
   * @param {object} violation - violation object
   * @returns {boolean} true if we can fix this
   */
  canFix(file, violation) {
    if (violation.criterion !== '1.4.4') return false;
    if (!file.isHtml) return false;

    const snippet = violation.snippet || '';

    // Check for the problematic viewport meta attributes
    const hasNoScale = /user-scalable\s*=\s*(no|0)/i.test(snippet);
    const hasLowMaxScale = /maximum-scale\s*=\s*[\d.]*1(?:\.0)?\b/i.test(snippet);

    return hasNoScale || hasLowMaxScale;
  },

  /**
   * Repair the violation by rewriting the viewport meta tag
   * @param {object} file - { path, content, isHtml }
   * @param {array} violations - violations this fixer can fix
   * @returns {object} { changed: bool, newContent: string, log: [] }
   */
  async fix(file, violations) {
    let newContent = file.content;
    const log = [];

    for (const violation of violations) {
      // Find the viewport meta tag with the problematic content
      const viewportRegex = /<meta\s+name\s*=\s*["']viewport["'][^>]*>/gi;
      let match;
      let found = false;

      // eslint-disable-next-line no-cond-assign
      while ((match = viewportRegex.exec(newContent)) !== null) {
        const fullTag = match[0];
        const contentMatch = fullTag.match(/content\s*=\s*["']([^"']*)["']/i);

        if (!contentMatch) continue;

        const content = contentMatch[1];

        // Check if this tag has the problematic attributes
        const hasNoScale = /user-scalable\s*=\s*(no|0)/i.test(content);
        const hasLowMaxScale = /maximum-scale\s*=\s*[\d.]*1(?:\.0)?\b/i.test(content);

        if (!hasNoScale && !hasLowMaxScale) {
          continue;
        }

        // Replace with a safe viewport meta tag
        const newTag = '<meta name="viewport" content="width=device-width, initial-scale=1.0">';
        newContent = newContent.replace(fullTag, newTag);
        log.push(`Replaced viewport meta with safe scaling settings at position ${match.index}`);
        found = true;
        break;
      }

      if (!found) {
        log.push(`Could not locate viewport meta tag for line ${violation.line}`);
      }
    }

    return {
      changed: log.length > 0,
      newContent,
      log
    };
  }
};
