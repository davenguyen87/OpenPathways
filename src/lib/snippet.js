const { lineOf } = require('./line-of');

/**
 * Extracts a snippet of source code around a given line.
 * Returns up to maxLen characters of the source line, trimmed.
 *
 * @param {string} content - The full content
 * @param {number} line - 1-indexed line number
 * @param {number} maxLen - Maximum length of the snippet (default: 160)
 * @returns {string} Trimmed source snippet
 */
function snippet(content, line, maxLen = 160) {
  const lines = content.split('\n');
  const targetLine = lines[line - 1] || '';

  const trimmed = targetLine.trim();

  if (trimmed.length > maxLen) {
    return trimmed.substring(0, maxLen) + '...';
  }

  return trimmed;
}

module.exports = { snippet };
