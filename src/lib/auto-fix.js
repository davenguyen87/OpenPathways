/**
 * Auto-fix orchestrator and zip rewriter
 * Loads fixers, applies them to violations in-memory, and rebuilds the zip
 */

const fs = require('fs').promises;
const path = require('path');
const yauzl = require('yauzl');
const yazl = require('yazl');

/**
 * Load all fixers from src/fixers/
 * Validate shape; warn-and-skip invalid ones
 * @returns {Promise<Array>} array of validated fixer modules
 */
async function loadFixers() {
  const fixersDir = path.join(__dirname, '..', 'fixers');
  let files = [];

  try {
    files = await fs.readdir(fixersDir);
  } catch (err) {
    console.warn(`[auto-fix] fixers directory not found: ${fixersDir}`);
    return [];
  }

  const fixers = [];
  for (const file of files) {
    if (!file.endsWith('.js')) continue;

    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const fixer = require(path.join(fixersDir, file));
      validateFixer(fixer);
      fixers.push(fixer);
    } catch (err) {
      console.warn(`[auto-fix] skipping invalid fixer ${file}: ${err.message}`);
    }
  }

  return fixers;
}

/**
 * Validate fixer shape
 * @param {object} fixer - fixer module to validate
 * @throws {Error} if fixer is missing required fields
 */
function validateFixer(fixer) {
  const required = ['id', 'name', 'supported', 'confidence', 'criterion', 'canFix', 'fix'];
  for (const field of required) {
    if (!(field in fixer)) {
      throw new Error(`fixer missing required field: ${field}`);
    }
  }
  if (typeof fixer.canFix !== 'function') {
    throw new Error('fixer.canFix must be a function');
  }
  if (typeof fixer.fix !== 'function') {
    throw new Error('fixer.fix must be a function');
  }
}

/**
 * Apply fixers to in-memory file contents
 * Group violations by file; for each file, iterate fixers; apply changes serially
 *
 * @param {object} options - { violations, files, options }
 * @returns {Promise<object>} { fixedFiles: Map, applied: [], skipped: [] }
 */
async function applyFixes({ violations, files, options = {} }) {
  const fixers = await loadFixers();
  const fixedFiles = new Map();
  const applied = [];
  const skipped = [];

  // Accept either Map<path, fileObj> or Array<fileObj>; normalize to Map
  let filesMap;
  if (files instanceof Map) {
    filesMap = files;
  } else if (Array.isArray(files)) {
    filesMap = new Map();
    for (const f of files) {
      if (f && f.path) filesMap.set(f.path, f);
    }
  } else {
    filesMap = new Map();
  }

  // Group violations by file path
  const violationsByFile = new Map();
  for (const v of violations) {
    if (!violationsByFile.has(v.file)) {
      violationsByFile.set(v.file, []);
    }
    violationsByFile.get(v.file).push(v);
  }

  // For each file with violations
  for (const [filePath, fileViolations] of violationsByFile) {
    // Find the file object in the files map
    let fileObj = filesMap.get(filePath);
    if (!fileObj) {
      // File not in map; skip
      for (const v of fileViolations) {
        skipped.push(v);
      }
      continue;
    }

    // Get current content (might be from fixedFiles if earlier fixer modified it)
    let currentContent = fixedFiles.has(filePath) ? fixedFiles.get(filePath) : fileObj.content;

    // Track which violations have been fixed
    const fixedViolations = new Set();

    // Iterate fixers in order; apply each one
    for (const fixer of fixers) {
      // Find violations this fixer can handle
      const canFixViolations = fileViolations.filter(v => {
        if (fixedViolations.has(v)) return false; // Already fixed
        return fixer.canFix(
          { path: filePath, content: currentContent, isHtml: filePath.match(/\.html?$/i) },
          v
        );
      });

      if (canFixViolations.length === 0) continue;

      // Apply fixer
      try {
        const result = await fixer.fix(
          { path: filePath, content: currentContent, isHtml: filePath.match(/\.html?$/i) },
          canFixViolations
        );

        if (result && result.changed) {
          currentContent = result.newContent;
          // Mark these violations as fixed
          for (const v of canFixViolations) {
            fixedViolations.add(v);
            applied.push({
              fixerId: fixer.id,
              file: filePath,
              line: v.line,
              criterion: v.criterion,
              message: v.message,
              confidence: fixer.confidence,
              log: result.log || []
            });
          }
        }
      } catch (err) {
        console.error(`[auto-fix] fixer ${fixer.id} error on ${filePath}: ${err.message}`);
      }
    }

    // Save fixed content
    if (fixedFiles.get(filePath) !== currentContent) {
      fixedFiles.set(filePath, currentContent);
    }

    // Remaining violations are skipped
    for (const v of fileViolations) {
      if (!fixedViolations.has(v)) {
        skipped.push(v);
      }
    }
  }

  // Second pass: run fixers on all HTML files (scan mode) even if no violations
  // This allows fixers like add-lang-attribute, add-title, add-html5-doctype, add-skip-link
  // to clean up files that don't have specific violations
  for (const [filePath, fileObj] of filesMap) {
    if (!fileObj.isHtml && !filePath.match(/\.html?$/i)) continue; // Skip non-HTML
    if (violationsByFile.has(filePath)) continue; // Already processed above

    let currentContent = fixedFiles.has(filePath) ? fixedFiles.get(filePath) : fileObj.content;
    let changed = false;

    for (const fixer of fixers) {
      // Call canFix with violation=null to trigger scan mode
      if (!fixer.canFix(
        { path: filePath, content: currentContent, isHtml: true },
        null
      )) {
        continue;
      }

      // Apply fixer in scan mode
      try {
        const result = await fixer.fix(
          { path: filePath, content: currentContent, isHtml: true },
          [] // Empty violations array for scan mode
        );

        if (result && result.changed) {
          currentContent = result.newContent;
          changed = true;
          applied.push({
            fixerId: fixer.id,
            file: filePath,
            line: null,
            criterion: fixer.criterion,
            message: `[scan mode] ${fixer.name}`,
            confidence: fixer.confidence,
            log: result.log || []
          });
        }
      } catch (err) {
        console.error(`[auto-fix] fixer ${fixer.id} error on ${filePath} (scan mode): ${err.message}`);
      }
    }

    if (changed) {
      fixedFiles.set(filePath, currentContent);
    }
  }

  return { fixedFiles, applied, skipped };
}

/**
 * Rebuild the zip from original + fixedFiles overrides
 * Use yauzl to enumerate original; for each entry, write new content from fixedFiles or original bytes
 *
 * @param {object} options - { originalZipPath, outputZipPath, fixedFiles }
 * @returns {Promise<object>} { written: bool, outputPath: string, bytes: number }
 */
async function writeFixedZip({ originalZipPath, outputZipPath, fixedFiles }) {
  return new Promise((resolve, reject) => {
    const outZip = new yazl.ZipFile();
    const writeStream = require('fs').createWriteStream(outputZipPath);
    let byteCount = 0;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    // Pipe yazl's output BEFORE calling outZip.end() — yazl streams as entries are added.
    outZip.outputStream.on('error', fail);
    writeStream.on('error', fail);
    writeStream.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve({ written: true, outputPath: outputZipPath, bytes: byteCount });
    });
    outZip.outputStream.pipe(writeStream);

    yauzl.open(originalZipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return fail(new Error(`Failed to read original zip: ${err.message}`));

      zipfile.on('entry', (entry) => {
        try {
          if (fixedFiles.has(entry.fileName)) {
            const newContent = fixedFiles.get(entry.fileName);
            const buf = Buffer.from(newContent, 'utf8');
            outZip.addBuffer(buf, entry.fileName);
            byteCount += buf.length;
            zipfile.readEntry();
          } else if (entry.fileName.endsWith('/')) {
            outZip.addEmptyDirectory(entry.fileName);
            zipfile.readEntry();
          } else {
            zipfile.openReadStream(entry, (err2, readStream) => {
              if (err2) return fail(err2);
              const chunks = [];
              readStream.on('data', (chunk) => chunks.push(chunk));
              readStream.on('end', () => {
                const buf = Buffer.concat(chunks);
                outZip.addBuffer(buf, entry.fileName);
                byteCount += buf.length;
                zipfile.readEntry();
              });
              readStream.on('error', fail);
            });
          }
        } catch (err2) {
          fail(err2);
        }
      });

      zipfile.on('end', () => {
        // Signal yazl no more entries are coming; outputStream will then end and writeStream will finish.
        outZip.end();
      });

      zipfile.on('error', fail);

      zipfile.readEntry();
    });
  });
}

module.exports = {
  loadFixers,
  applyFixes,
  writeFixedZip
};
