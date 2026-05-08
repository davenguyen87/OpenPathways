/**
 * Packager — round-trips a SCORM-style `.zip` between disk and a temp directory
 * while preserving entry order and binary integrity.
 *
 * Uses `yauzl` (read) and `yazl` (write); both are already direct dependencies
 * of the repo. Do NOT add `adm-zip` — see v4/CLAUDE.md "no new runtime
 * dependencies" rule. (The 01-orchestrator.md prompt mentions adm-zip in
 * passing; treat that as a documentation drift, not a license to add a dep.)
 *
 * Entry order is captured during `unpack` and persisted as a sidecar file at
 * `<destDir>/.prism-entry-order.json` so `pack` can restore the exact order
 * without the caller threading state through. The sidecar is excluded from
 * the produced zip.
 *
 * Round-trip invariant: for any zip Z,
 *   unpack(Z, dir); pack(dir, Z2, emptyManifest)
 * yields a zip Z2 whose entry-by-entry file *bytes* are identical to Z. Zip
 * metadata SHA may differ (compression timestamps, etc.) — that is expected.
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const yauzl = require('yauzl');
const yazl = require('yazl');

const ENTRY_ORDER_FILENAME = '.prism-entry-order.json';

/**
 * Extract a zip into `destDir`. Records each entry's fileName in the order
 * yauzl emits them; persists that list at `<destDir>/.prism-entry-order.json`
 * so `pack` can read it back without coupling.
 *
 * Mirrors the path-traversal-rejecting pattern in `src/lib/extract.js`.
 *
 * @param {string} zipPath
 * @param {string} destDir
 * @returns {Promise<{ entryOrder: string[] }>}
 */
async function unpack(zipPath, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  const entryOrder = [];

  await new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(new Error(`Failed to open ZIP: ${err.message}`));

      zipfile.readEntry();

      zipfile.on('entry', (entry) => {
        // Capture original entry order (including directory entries) so we
        // can replay it byte-for-stream-order on repack.
        entryOrder.push(entry.fileName);

        const entryPath = path.normalize(entry.fileName);
        if (entryPath.startsWith('..') || path.isAbsolute(entryPath)) {
          return reject(new Error(`Path traversal detected: ${entry.fileName}`));
        }

        const fullPath = path.join(destDir, entryPath);
        const resolved = path.resolve(fullPath);
        const destResolved = path.resolve(destDir);
        if (!resolved.startsWith(destResolved)) {
          return reject(new Error(`Path traversal detected: ${entry.fileName}`));
        }

        if (entry.fileName.endsWith('/')) {
          fsp.mkdir(fullPath, { recursive: true })
            .then(() => zipfile.readEntry())
            .catch(reject);
          return;
        }

        fsp.mkdir(path.dirname(fullPath), { recursive: true })
          .then(() => {
            zipfile.openReadStream(entry, (rsErr, readStream) => {
              if (rsErr) return reject(rsErr);
              const writeStream = fs.createWriteStream(fullPath);
              writeStream.on('finish', () => zipfile.readEntry());
              writeStream.on('error', reject);
              readStream.on('error', reject);
              readStream.pipe(writeStream);
            });
          })
          .catch(reject);
      });

      zipfile.on('end', resolve);
      zipfile.on('error', reject);
    });
  });

  // Persist order so pack() can recover it without an extra parameter.
  await fsp.writeFile(
    path.join(destDir, ENTRY_ORDER_FILENAME),
    JSON.stringify(entryOrder),
    'utf8'
  );

  return { entryOrder };
}

/**
 * Recursively walk `srcDir` and return relative entry paths (forward-slash)
 * in stable lexicographic order. Used as a fallback when the entry-order
 * sidecar is missing.
 *
 * @param {string} srcDir
 * @returns {Promise<string[]>}
 */
async function walkSorted(srcDir) {
  const out = [];
  async function walk(dir, rel) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push(`${r}/`);
        await walk(full, r);
      } else if (e.isFile()) {
        out.push(r);
      }
    }
  }
  await walk(srcDir, '');
  return out;
}

/**
 * Repack a directory back into a `.zip`. Replays entry order from the
 * sidecar written by `unpack`; falls back to a sorted recursive walk if the
 * sidecar is missing (e.g., when a caller assembled `srcDir` from scratch).
 *
 * The `manifest` argument is informational. v4 fixers never delete files,
 * so we always preserve every entry verbatim. Wired through so future
 * "delete-file" fixers can consult it without an API change.
 *
 * @param {string} srcDir
 * @param {string} zipPath
 * @param {*} _manifest - reserved; see comment above
 * @returns {Promise<void>}
 */
async function pack(srcDir, zipPath, _manifest) {
  let entryOrder;
  const sidecarPath = path.join(srcDir, ENTRY_ORDER_FILENAME);
  try {
    const raw = await fsp.readFile(sidecarPath, 'utf8');
    entryOrder = JSON.parse(raw);
    if (!Array.isArray(entryOrder)) throw new Error('entry-order sidecar is not an array');
  } catch (_) {
    entryOrder = await walkSorted(srcDir);
  }

  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const writeStream = fs.createWriteStream(zipPath);
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    zip.outputStream.on('error', fail);
    writeStream.on('error', fail);
    writeStream.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zip.outputStream.pipe(writeStream);

    (async () => {
      try {
        for (const entryPath of entryOrder) {
          if (entryPath === ENTRY_ORDER_FILENAME) continue;

          if (entryPath.endsWith('/')) {
            zip.addEmptyDirectory(entryPath);
            continue;
          }

          const diskPath = path.join(srcDir, entryPath);
          let stat;
          try {
            stat = await fsp.stat(diskPath);
          } catch (_) {
            // File listed in entry-order but missing on disk — likely a
            // delete-file fixer in a later release. v4 has none, so we just
            // skip and keep going.
            continue;
          }

          if (stat.isDirectory()) {
            // A directory entry that wasn't recorded with a trailing slash.
            zip.addEmptyDirectory(entryPath.endsWith('/') ? entryPath : `${entryPath}/`);
            continue;
          }

          if (stat.size === 0) {
            // yazl handles empty files via addBuffer; addFile streams and is
            // fine with size-0 too on current yazl, but the empty-buffer path
            // is unambiguous.
            zip.addBuffer(Buffer.alloc(0), entryPath);
          } else {
            zip.addFile(diskPath, entryPath);
          }
        }
        zip.end();
      } catch (err) {
        fail(err);
      }
    })();
  });
}

/**
 * Compute SHA-256 of a file as a hex digest by streaming the file through
 * crypto.createHash. Streaming avoids slurping multi-MB zips into memory.
 *
 * @param {string} filePath
 * @returns {Promise<string>}
 */
function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

module.exports = {
  unpack,
  pack,
  sha256,
  ENTRY_ORDER_FILENAME
};
