const fs = require('fs').promises;
const path = require('path');

/**
 * Find a file by pattern (case-insensitive) within a root directory.
 * Recursively searches the directory tree. Pattern can be:
 *   - Exact filename: "imsmanifest.xml"
 *   - Wildcard pattern: "*.crs" (matches any case)
 *
 * @param {string} root - Root directory to search
 * @param {string} pattern - Filename or glob pattern (e.g. "*.crs", "imsmanifest.xml")
 * @param {object} opts - { recursive: true, preferShallowest: true }
 * @returns {Promise<string|null>} - Absolute path to first match, or null
 */
async function findFile(root, pattern, opts = {}) {
  const { recursive = true, preferShallowest = false } = opts;

  // Convert glob pattern to regex (simple version: support *.ext)
  const regexPattern = patternToRegex(pattern);

  const matches = [];
  await searchDir(root, regexPattern, matches);

  if (matches.length === 0) return null;

  // If preferShallowest, sort by depth and return shallowest
  if (preferShallowest && matches.length > 1) {
    matches.sort((a, b) => {
      const depthA = a.split(path.sep).length;
      const depthB = b.split(path.sep).length;
      return depthA - depthB;
    });
  }

  return matches[0];
}

/**
 * Recursively search a directory for files matching a regex pattern.
 * @param {string} dir - Directory to search
 * @param {RegExp} regexPattern - Pattern to match against filenames
 * @param {array} matches - Accumulator for matching file paths
 * @param {number} maxDepth - Maximum recursion depth (prevent infinite loops)
 */
async function searchDir(dir, regexPattern, matches, maxDepth = 20) {
  if (maxDepth <= 0) return;

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isFile()) {
        if (regexPattern.test(entry.name)) {
          matches.push(fullPath);
        }
      } else if (entry.isDirectory() && entry.name !== 'node_modules') {
        // Avoid node_modules and other typical ignore dirs
        await searchDir(fullPath, regexPattern, matches, maxDepth - 1);
      }
    }
  } catch (err) {
    // Silently ignore permission errors, etc.
  }
}

/**
 * Convert a simple glob pattern to a RegExp.
 * Supports: *.ext, exact filenames, case-insensitive matching
 * @param {string} pattern - Pattern like "*.crs" or "imsmanifest.xml"
 * @returns {RegExp} - Case-insensitive regex
 */
function patternToRegex(pattern) {
  if (pattern === '*' || pattern === '**') {
    return /./;
  }

  if (pattern.startsWith('*.')) {
    // *.ext pattern
    const ext = pattern.slice(2);
    return new RegExp(`\\.${ext}$`, 'i');
  }

  // Exact filename match (case-insensitive)
  return new RegExp(`^${pattern}$`, 'i');
}

/**
 * Read a text file, stripping BOM if present.
 * @param {string} filePath - Absolute path to file
 * @returns {Promise<string>} - File contents (trimmed BOM)
 */
async function readText(filePath) {
  let content = await fs.readFile(filePath, 'utf-8');
  // Strip BOM if present
  if (content.charCodeAt(0) === 0xFEFF) {
    content = content.slice(1);
  }
  return content;
}

/**
 * Parse a CSV-like format with quoted field support.
 * Handles fields like: "value with, comma", simple_value, another_value
 * @param {string} text - CSV text (single line or multi-line)
 * @returns {string[]} - Array of parsed field values
 */
function parseAiccCsv(text) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote
        current += '"';
        i++; // Skip next quote
      } else {
        // Toggle quote state
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      // Field separator
      fields.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  // Add final field
  fields.push(current.trim());
  return fields;
}

/**
 * Parse INI-like format with sections and key=value pairs.
 * Example:
 *   [Course]
 *   Course_ID=ABC123
 *   Version=1
 *   [Course_Behavior]
 *   Max_Normal=10
 * @param {string} text - INI text
 * @returns {object} - { sectionName: { key: value, ... }, ... }
 */
function parseIniLike(text) {
  const result = {};
  let currentSection = null;

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';')) {
      // Skip empty lines and comments
      continue;
    }

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      // Section header
      currentSection = trimmed.slice(1, -1);
      result[currentSection] = {};
    } else if (currentSection && trimmed.includes('=')) {
      // Key=value pair
      const [key, ...valueParts] = trimmed.split('=');
      const value = valueParts.join('=').trim();
      result[currentSection][key.trim()] = value;
    }
  }

  return result;
}

module.exports = {
  findFile,
  readText,
  parseAiccCsv,
  parseIniLike,
};
