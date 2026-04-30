/**
 * Add tabindex="0" to interactive elements with keyboard handlers
 * Detects custom elements with onclick + keyboard handlers but missing tabindex
 */

module.exports = {
  id: 'add-tabindex-keyboard',
  name: 'Add tabindex="0" to keyboard-aware elements',
  supported: ['scorm12', 'scorm2004', 'aicc'],
  confidence: 'definitive',
  criterion: '2.1.1',

  /**
   * Check if this fixer can repair the violation
   * @param {object} file - { path, content, isHtml }
   * @param {object} violation - violation object
   * @returns {boolean} true if we can fix this
   */
  canFix(file, violation) {
    if (violation.criterion !== '2.1.1') return false;
    if (!file.isHtml) return false;

    const snippet = violation.snippet || '';

    // We can fix if:
    // - Element already has a keyboard handler (onkeydown, onkeyup, onkeypress)
    // - Element does NOT already have tabindex
    // - Element has onclick or role="button"/"link"

    const hasKeyHandler = /on(keydown|keyup|keypress)/i.test(snippet);
    const hasTabindex = /tabindex\s*=/i.test(snippet);
    const hasOnclick = /onclick\s*=/i.test(snippet);
    const hasButtonRole = /role\s*=\s*["'](button|link)["']/i.test(snippet);

    // We can fix if: has keyboard handler AND (no tabindex) AND (has onclick or button role)
    return hasKeyHandler && !hasTabindex && (hasOnclick || hasButtonRole);
  },

  /**
   * Repair the violation by adding tabindex="0"
   * @param {object} file - { path, content, isHtml }
   * @param {array} violations - violations this fixer can fix
   * @returns {object} { changed: bool, newContent: string, log: [] }
   */
  async fix(file, violations) {
    let newContent = file.content;
    const log = [];

    for (const violation of violations) {
      const snippet = violation.snippet || '';
      const line = violation.line || null;

      // Find the element tag in the content
      // We'll search for a tag that matches the snippet and lacks tabindex
      // Simple approach: find the opening tag

      // Extract the tag name from snippet (e.g., <div onclick=...> -> div)
      const tagMatch = snippet.match(/<(\w+)[^>]*>/);
      if (!tagMatch) {
        log.push(`Could not extract tag name from snippet on line ${line}`);
        continue;
      }

      const tagName = tagMatch[1].toLowerCase();

      // Build a regex to find this specific tag with the onclick/onkey handler
      const elementRegex = new RegExp(
        `<${tagName}[^>]*(?:onclick|onkeydown|onkeyup|onkeypress)[^>]*>`,
        'gi'
      );
      let match;
      let found = false;

      // eslint-disable-next-line no-cond-assign
      while ((match = elementRegex.exec(newContent)) !== null) {
        const fullTag = match[0];
        const attrs = match[1] || '';

        // Skip if already has tabindex
        if (/\stabindex\s*=/i.test(fullTag)) {
          continue;
        }

        // Check if snippet matches this tag (rough match on the handler)
        if (snippet.length > 0 && fullTag.includes(snippet.substring(0, 30))) {
          // Insert tabindex="0" before the closing >
          const newTag = fullTag.replace(/>$/, ' tabindex="0">');
          newContent = newContent.replace(fullTag, newTag);
          log.push(`Added tabindex="0" to <${tagName}> at position ${match.index}`);
          found = true;
          break;
        }
      }

      if (!found) {
        log.push(`Could not locate matching <${tagName}> for line ${line}`);
      }
    }

    return {
      changed: log.length > 0,
      newContent,
      log
    };
  }
};
