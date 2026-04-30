const yauzl = require('yauzl');
const fs = require('fs').promises;
const path = require('path');

/**
 * Extracts a ZIP file to a destination directory.
 * Rejects path traversal attacks (no .. segments, no absolute paths).
 *
 * @param {string} zipPath - Path to .zip file
 * @param {string} destDir - Destination directory
 * @returns {Promise<void>}
 */
async function extractZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(new Error(`Failed to open ZIP: ${err.message}`));

      zipfile.readEntry();

      zipfile.on('entry', async (entry) => {
        try {
          // Security: reject path traversal
          const entryPath = path.normalize(entry.fileName);
          if (entryPath.startsWith('..') || path.isAbsolute(entryPath)) {
            return reject(new Error(`Path traversal detected: ${entry.fileName}`));
          }

          const fullPath = path.join(destDir, entryPath);

          // Ensure the resolved path is still within destDir
          const resolved = path.resolve(fullPath);
          const destResolved = path.resolve(destDir);
          if (!resolved.startsWith(destResolved)) {
            return reject(new Error(`Path traversal detected: ${entry.fileName}`));
          }

          if (entry.fileName.endsWith('/')) {
            // Directory
            await fs.mkdir(fullPath, { recursive: true });
            zipfile.readEntry();
          } else {
            // File
            await fs.mkdir(path.dirname(fullPath), { recursive: true });

            zipfile.openReadStream(entry, (err, readStream) => {
              if (err) return reject(err);

              const writeStream = require('fs').createWriteStream(fullPath);
              writeStream.on('finish', () => {
                zipfile.readEntry();
              });
              writeStream.on('error', reject);
              readStream.on('error', reject);
              readStream.pipe(writeStream);
            });
          }
        } catch (err) {
          reject(err);
        }
      });

      zipfile.on('end', resolve);
      zipfile.on('error', reject);
    });
  });
}

module.exports = { extractZip };
