const fs = require('fs').promises;
const path = require('path');

const TEXT_EXTENSIONS = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.xml', '.svg', '.json']);

/**
 * Checks if a buffer looks like text (no null bytes).
 * @param {Buffer} buffer
 * @returns {boolean}
 */
function isTextBuffer(buffer) {
  if (buffer.length === 0) return true;
  // Check first 8KB for null bytes
  const checkSize = Math.min(buffer.length, 8192);
  return !buffer.slice(0, checkSize).includes(0);
}

/**
 * Walks the extracted package directory and collects all text files.
 * Returns { html, css, js, all } arrays. Each entry: { path, content }.
 * Path is package-relative (forward-slash).
 *
 * @param {string} packageRoot - Root directory of extracted package
 * @returns {Promise<{ html: Array, css: Array, js: Array, all: Array }>}
 */
async function loadFiles(packageRoot) {
  const html = [];
  const css = [];
  const js = [];
  const all = [];

  async function walk(dir, relDir = '') {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      return; // Skip inaccessible directories
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        await walk(fullPath, relPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();

        // Check if extension is in the whitelist
        let isText = TEXT_EXTENSIONS.has(ext);

        // If not in whitelist, check the buffer for null bytes
        if (!isText) {
          try {
            const buffer = await fs.readFile(fullPath);
            isText = isTextBuffer(buffer);
          } catch (err) {
            continue; // Skip unreadable files
          }
        }

        if (isText) {
          try {
            const content = await fs.readFile(fullPath, 'utf8');
            const normalizedPath = relPath.replace(/\\/g, '/'); // Force forward slashes

            const fileEntry = { path: normalizedPath, content };
            all.push(fileEntry);

            if (ext === '.html' || ext === '.htm') {
              html.push(fileEntry);
            } else if (ext === '.css') {
              css.push(fileEntry);
            } else if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
              js.push(fileEntry);
            }
          } catch (err) {
            // Skip files that can't be read as UTF-8
          }
        }
      }
    }
  }

  await walk(packageRoot);
  return { html, css, js, all };
}

module.exports = { loadFiles };
