/**
 * Add autocomplete="current-password" to password inputs
 * Detects password inputs missing autocomplete attribute
 */

module.exports = {
  id: 'add-autocomplete-password',
  name: 'Add autocomplete="current-password" to password inputs',
  supported: ['scorm12', 'scorm2004', 'aicc'],
  confidence: 'definitive',
  criterion: '3.3.8',

  /**
   * Check if this fixer can repair the violation
   * @param {object} file - { path, content, isHtml }
   * @param {object} violation - violation object
   * @returns {boolean} true if we can fix this
   */
  canFix(file, violation) {
    if (violation.criterion !== '3.3.8') return false;
    if (!file.isHtml) return false;

    const snippet = violation.snippet || '';

    // Look for <input type="password"> without autocomplete
    const isPasswordInput = /type\s*=\s*["']password["']/i.test(snippet);
    const hasAutocomplete = /autocomplete\s*=/i.test(snippet);

    return isPasswordInput && !hasAutocomplete;
  },

  /**
   * Repair the violation by adding autocomplete="current-password"
   * @param {object} file - { path, content, isHtml }
   * @param {array} violations - violations this fixer can fix
   * @returns {object} { changed: bool, newContent: string, log: [] }
   */
  async fix(file, violations) {
    let newContent = file.content;
    const log = [];

    for (const violation of violations) {
      const snippet = violation.snippet || '';

      // Find <input type="password"> tags
      const inputRegex = /<input\s+([^>]*?type\s*=\s*["']password["'][^>]*)>/gi;
      let match;
      let found = false;

      // eslint-disable-next-line no-cond-assign
      while ((match = inputRegex.exec(newContent)) !== null) {
        const fullTag = match[0];
        const attrs = match[1];

        // Skip if already has autocomplete
        if (/autocomplete\s*=/i.test(attrs)) {
          continue;
        }

        // Check if this matches our snippet
        if (snippet.length === 0 || fullTag.includes(snippet.substring(0, 30))) {
          // Insert autocomplete before the closing > or />
          const newTag = fullTag.replace(/(\/?)>\s*$/, ' autocomplete="current-password"$1>');
          newContent = newContent.replace(fullTag, newTag);
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
      changed: log.length > 0,
      newContent,
      log
    };
  }
};
