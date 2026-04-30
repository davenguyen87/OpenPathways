/**
 * Returns the 1-indexed line number for a given byte offset in content.
 * If a substring is provided, finds the first occurrence and returns its line number.
 *
 * @param {string} content - The full content
 * @param {number|string} indexOrSubstring - Byte offset or substring to find
 * @returns {number} 1-indexed line number
 */
function lineOf(content, indexOrSubstring) {
  let index;

  if (typeof indexOrSubstring === 'string') {
    index = content.indexOf(indexOrSubstring);
    if (index === -1) return 1; // Default to line 1 if substring not found
  } else {
    index = Math.max(0, Math.min(indexOrSubstring, content.length - 1));
  }

  // Count newlines from start to index
  let lineNum = 1;
  for (let i = 0; i < index; i++) {
    if (content[i] === '\n') lineNum++;
  }

  return lineNum;
}

module.exports = { lineOf };
