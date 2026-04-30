const path = require('path');
const { readText, findFile, parseAiccCsv, parseIniLike } = require('./util');

/**
 * Parse an AICC package.
 * AICC packages contain: .crs (course descriptor, INI-like), .au (assignable units, CSV),
 * .des (descriptors, optional), and .cst (course structure, optional).
 * We support profiles 1–2 only. Profile 3+ return a clear error.
 *
 * @param {string} packageRoot - Absolute path to extracted package
 * @returns {Promise<{ entryPoints: string[], manifest: object }>}
 * @throws {Error} - If AICC profile 3/4 is detected
 */
async function parseAiccPackage(packageRoot) {
  // Find .crs file (case-insensitive)
  const crsPath = await findFile(packageRoot, '*.crs', { recursive: true });
  if (!crsPath) {
    throw new Error('AICC .crs file not found.');
  }

  // Parse .crs (INI-like format)
  const crsContent = await readText(crsPath);
  const crsData = parseIniLike(crsContent);

  // Extract course info from [Course] section
  const courseSection = crsData['Course'] || {};
  const courseInfo = {
    creator: courseSection.Course_Creator || null,
    id: courseSection.Course_ID || null,
    version: courseSection.Course_Version || null,
  };

  // Find .au file (CSV with assignable units)
  const auPath = await findFile(packageRoot, '*.au', { recursive: true });
  if (!auPath) {
    throw new Error('AICC .au file not found.');
  }

  // Parse .au (CSV format)
  const auContent = await readText(auPath);
  const auLines = auContent.split(/\r?\n/).filter((line) => line.trim());

  if (auLines.length === 0) {
    throw new Error('AICC .au file is empty.');
  }

  // First line is header
  const headers = parseAiccCsv(auLines[0]);
  const systemIdIdx = headers.findIndex((h) => h.toLowerCase() === 'system_id');
  const fileNameIdx = headers.findIndex((h) => h.toLowerCase() === 'file_name');

  if (systemIdIdx < 0 || fileNameIdx < 0) {
    throw new Error('AICC .au file missing required System_ID or File_Name columns.');
  }

  // Parse .au rows
  const entryPoints = [];
  const unconventionalEntries = [];
  const seenFiles = new Set();

  for (let i = 1; i < auLines.length; i++) {
    const fields = parseAiccCsv(auLines[i]);
    if (fields.length <= fileNameIdx) continue;

    let fileName = fields[fileNameIdx].trim();
    if (!fileName) continue;

    // Normalize to forward slashes
    fileName = fileName.replace(/\\/g, '/');

    // Deduplicate
    if (seenFiles.has(fileName)) continue;
    seenFiles.add(fileName);

    // Check if it's an HTML file
    const isHtml = fileName.toLowerCase().endsWith('.html') || fileName.toLowerCase().endsWith('.htm');

    if (isHtml) {
      entryPoints.push(fileName);
    } else {
      // Non-HTML entry points (may be wrappers or dynamic loaders)
      unconventionalEntries.push(fileName);
      entryPoints.push(fileName);
    }
  }

  // Determine AICC profile
  // Profile 1: only .crs + .au
  // Profile 2: adds .des
  // Profile 3+: includes .cst with advanced features (prerequisites, block sequencing)
  let profile = 1;

  // Check for .des file (profile 2+)
  const desPath = await findFile(packageRoot, '*.des', { recursive: true });
  if (desPath) {
    profile = 2;
  }

  // Check for .cst file and profile 3/4 indicators
  const cstPath = await findFile(packageRoot, '*.cst', { recursive: true });
  if (cstPath) {
    const cstContent = await readText(cstPath);
    // Heuristic for profile 3+: look for "Block" field or "Prerequisites" column
    if (cstContent.includes('Block') || cstContent.match(/prerequisites/i)) {
      throw new Error('AICC profile 3/4 is not supported. Only profiles 1 and 2 are supported.');
    }
  }

  return {
    entryPoints,
    manifest: {
      version: 'aicc',
      profile,
      courseInfo,
      crs: crsData,
      unconventionalEntries: unconventionalEntries.length > 0 ? unconventionalEntries : undefined,
    },
  };
}

module.exports = {
  parseAiccPackage,
};
