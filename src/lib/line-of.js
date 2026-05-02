/**
 * Returns the 1-indexed line number for a given byte offset in content.
 * If a substring is provided, finds the first occurrence and returns its line number.
 * Returns null when a substring is provided but not found in the content
 * (avoids false-positive "line 1" attributions when locators are imprecise —
 * e.g. cheerio-rendered HTML that doesn't byte-match the source).
 *
 * @param {string} content - The full content
 * @param {number|string} indexOrSubstring - Byte offset or substring to find
 * @returns {number|null} 1-indexed line number, or null if substring not found
 */
function lineOf(content, indexOrSubstring) {
  let index;

  if (typeof indexOrSubstring === 'string') {
    index = content.indexOf(indexOrSubstring);
    if (index === -1) return null; // Unknown line — better than misreporting line 1
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
