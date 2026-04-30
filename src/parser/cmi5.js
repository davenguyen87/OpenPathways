const path = require('path');
const { readText, findFile } = require('./util');
const xml2js = require('xml2js');

/**
 * Parse a cmi5 package.
 * cmi5 packages contain: cmi5.xml at the root with <au> (assignable unit) elements that have <url> children.
 * cmi5 is the modern xAPI profile published by ADL.
 *
 * Module shape matches SCORM parser:
 *   { entryPoints: string[], scos: Array<{id, title, entryFile}>, manifest: object }
 *
 * @param {string} packageRoot - Absolute path to extracted package
 * @returns {Promise<{ entryPoints: string[], scos: object[], manifest: object }>}
 * @throws {Error} - If cmi5.xml is missing or malformed
 */
async function parseCmi5Package(packageRoot) {
  // Find cmi5.xml at package root
  const cmi5Path = await findFile(packageRoot, 'cmi5.xml', {
    recursive: false,
    preferShallowest: true,
  });

  if (!cmi5Path) {
    throw new Error('cmi5.xml not found at package root');
  }

  // Read and parse XML
  const cmi5Content = await readText(cmi5Path);
  const parser = new xml2js.Parser({ ignoreAttrs: false, attrNameProcessors: [fixAttrCase] });

  let parsed;
  try {
    parsed = await parser.parseStringPromise(cmi5Content);
  } catch (err) {
    throw new Error(`Failed to parse cmi5.xml: ${err.message}`);
  }

  // Extract courseStructure root
  const courseStructure = parsed.courseStructure || {};

  // Collect all AUs (assignable units), recursively through blocks
  const entryPoints = [];
  const scos = [];
  const ausArray = collectAus(courseStructure);

  for (const au of ausArray) {
    const auId = au.$?.id;
    const titleElement = au.title;
    const urlElement = au.url;

    // Extract AU title (prefer title element, fall back to id)
    let auTitle = auId;
    if (titleElement) {
      const titleArray = Array.isArray(titleElement) ? titleElement : [titleElement];
      if (titleArray.length > 0) {
        const titleValue = titleArray[0];
        if (typeof titleValue === 'string') {
          auTitle = titleValue;
        } else if (titleValue && typeof titleValue === 'object') {
          // Extract text from langstring
          const langstringElement = titleValue.langstring;
          if (langstringElement) {
            const langstringArray = Array.isArray(langstringElement) ? langstringElement : [langstringElement];
            if (langstringArray.length > 0) {
              const ls = langstringArray[0];
              if (typeof ls === 'string') {
                auTitle = ls;
              } else if (ls && typeof ls === 'object' && ls._) {
                auTitle = ls._;
              }
            }
          }
        }
      }
    }

    // Extract URL element if present
    if (urlElement) {
      const urlArray = Array.isArray(urlElement) ? urlElement : [urlElement];
      for (const url of urlArray) {
        let urlPath = url;
        if (typeof url === 'object' && url._) {
          urlPath = url._;
        } else if (typeof url === 'object') {
          // Try to extract text content
          continue; // Skip if we can't extract a path
        }

        if (typeof urlPath === 'string' && urlPath.trim()) {
          // Skip absolute URLs (external resources)
          if (urlPath.startsWith('http://') || urlPath.startsWith('https://') || urlPath.startsWith('//')) {
            continue;
          }

          // Normalize to forward slashes
          const normalizedPath = urlPath.replace(/\\/g, '/').trim();

          // Add to entry points and SCOs
          if (!entryPoints.includes(normalizedPath)) {
            entryPoints.push(normalizedPath);
          }

          scos.push({
            id: auId || `au-${scos.length}`,
            title: auTitle,
            entryFile: normalizedPath,
          });
        }
      }
    }
  }

  // Validate that we found at least one launchable AU
  if (entryPoints.length === 0) {
    return {
      errors: ['cmi5 package has no launchable assignable units'],
    };
  }

  return {
    entryPoints,
    scos,
    manifest: {
      version: 'cmi5',
      cmi5PackageType: 'cmi5',
      ausCount: ausArray.length,
      launchableCount: entryPoints.length,
    },
  };
}

/**
 * Recursively collect all <au> (assignable unit) elements from courseStructure.
 * AUs may be nested inside <block> containers for grouping.
 *
 * @param {object} courseStructure - The parsed courseStructure element
 * @returns {array} - Array of all <au> elements found
 */
function collectAus(courseStructure) {
  const aus = [];

  // Collect direct <au> children
  const auArray = courseStructure.au || [];
  const directAus = Array.isArray(auArray) ? auArray : [auArray];
  aus.push(...directAus.filter(Boolean));

  // Recursively collect <au> elements inside <block> containers
  const blockArray = courseStructure.block || [];
  const blocks = Array.isArray(blockArray) ? blockArray : [blockArray];
  for (const block of blocks) {
    if (block && typeof block === 'object') {
      aus.push(...collectAus(block));
    }
  }

  return aus;
}

/**
 * Process attribute names (placeholder for xml2js compatibility)
 */
function fixAttrCase(name) {
  return name;
}

module.exports = {
  parseCmi5Package,
};
