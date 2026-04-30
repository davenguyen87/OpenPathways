/**
 * Add title attribute to <iframe> elements
 * Detects iframes without title and adds a descriptive title attribute
 */

module.exports = {
  id: 'add-iframe-title',
  name: 'Add title attribute to <iframe>',
  supported: ['scorm12', 'scorm2004', 'aicc', 'xapi', 'cmi5'],
  confidence: 'definitive',
  criterion: '4.1.2',

  /**
   * Check if this fixer can repair the violation
   * @param {object} file - { path, content, isHtml }
   * @param {object} violation - violation object or null
   * @returns {boolean} true if we can fix this
   */
  canFix(file, violation) {
    if (!file.isHtml) return false;

    // Scan mode: check for iframes without title
    const iframeRegex = /<iframe[^>]*>/gi;
    let match;

    // eslint-disable-next-line no-cond-assign
    while ((match = iframeRegex.exec(file.content)) !== null) {
      const tag = match[0];
      // If no title attribute, we can fix it
      if (!/\stitle\s*=/i.test(tag)) {
        return true;
      }
    }

    return false;
  },

  /**
   * Repair the violation by adding title attribute to iframes
   * @param {object} file - { path, content, isHtml }
   * @param {array} violations - violations this fixer can fix
   * @returns {object} { changed: bool, newContent: string, log: [] }
   */
  async fix(file, violations) {
    let newContent = file.content;
    const log = [];

    // Find all iframes without title
    const iframeRegex = /<iframe([^>]*?)>/gi;
    let match;
    const iframeMatches = [];

    // Collect all matches first to avoid regex state issues
    // eslint-disable-next-line no-cond-assign
    while ((match = iframeRegex.exec(file.content)) !== null) {
      iframeMatches.push({
        fullTag: match[0],
        attrs: match[1],
        index: match.index
      });
    }

    // Process matches in reverse order to maintain indices
    for (let i = iframeMatches.length - 1; i >= 0; i--) {
      const item = iframeMatches[i];
      const { fullTag, attrs } = item;

      // Skip if already has title
      if (/\stitle\s*=/i.test(attrs)) {
        continue;
      }

      // Extract title from src if possible, otherwise use generic
      let titleValue = 'Embedded content';
      const srcMatch = /\ssrc\s*=\s*["']([^"']+)["']/i.exec(attrs);
      if (srcMatch) {
        const srcUrl = srcMatch[1];
        try {
          // Extract hostname or last path segment
          if (srcUrl.includes('://')) {
            // It's an absolute URL
            const url = new URL(srcUrl);
            const hostname = url.hostname.replace(/^www\./, '');
            // Capitalize and make human-readable
            titleValue = `Embedded ${hostname} content`;
          } else if (srcUrl.startsWith('/') || srcUrl.includes('.')) {
            // Relative URL - use last path segment
            const lastSegment = srcUrl.split('/').pop().split('.')[0];
            if (lastSegment && lastSegment.length > 0) {
              titleValue = `Embedded ${lastSegment} content`;
            }
          }
        } catch (err) {
          // URL parsing failed; use generic title
          titleValue = 'Embedded content';
        }
      }

      // Insert title before closing >
      const newTag = fullTag.replace(/>\s*$/, ` title="${titleValue}">`);
      newContent = newContent.replace(fullTag, newTag);
      log.push(`Added title="${titleValue}" to <iframe> at position ${item.index}`);
    }

    return {
      changed: log.length > 0,
      newContent,
      log
    };
  }
};
