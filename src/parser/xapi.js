const path = require('path');
const { readText, findFile } = require('./util');
const xml2js = require('xml2js');

/**
 * Parse an xAPI / Tin Can package.
 * xAPI packages contain: tincan.xml at the root with <activities> that have <launch> elements.
 * An activity with a <launch> element is roughly equivalent to a SCORM SCO.
 *
 * Module shape matches SCORM parser:
 *   { entryPoints: string[], scos: Array<{id, title, entryFile}>, manifest: object }
 *
 * @param {string} packageRoot - Absolute path to extracted package
 * @returns {Promise<{ entryPoints: string[], scos: object[], manifest: object }>}
 * @throws {Error} - If tincan.xml is missing or malformed
 */
async function parseXapiPackage(packageRoot) {
  // Find tincan.xml at package root
  const tincantPath = await findFile(packageRoot, 'tincan.xml', {
    recursive: false,
    preferShallowest: true,
  });

  if (!tincantPath) {
    throw new Error('tincan.xml not found at package root');
  }

  // Read and parse XML
  const tincantContent = await readText(tincantPath);
  const parser = new xml2js.Parser({ ignoreAttrs: false, attrNameProcessors: [fixAttrCase] });

  let parsed;
  try {
    parsed = await parser.parseStringPromise(tincantContent);
  } catch (err) {
    throw new Error(`Failed to parse tincan.xml: ${err.message}`);
  }

  // Extract tincan root
  const tincan = parsed.tincan || {};

  // Extract activities
  const activitiesArray = tincan.activities || [];
  const activitiesElement = Array.isArray(activitiesArray) ? activitiesArray[0] : activitiesArray;

  if (!activitiesElement) {
    throw new Error('No <activities> element found in tincan.xml');
  }

  // Collect launchable activities
  const entryPoints = [];
  const scos = [];
  const activityArray = activitiesElement.activity || [];
  const activities = Array.isArray(activityArray) ? activityArray : [activityArray];

  for (const activity of activities) {
    const activityId = activity.$?.id;
    const nameElement = activity.name;
    const launchElement = activity.launch;

    // Extract activity name (prefer name element, fall back to id)
    let activityName = activityId;
    if (nameElement) {
      const nameArray = Array.isArray(nameElement) ? nameElement : [nameElement];
      if (nameArray.length > 0) {
        const nameValue = nameArray[0];
        if (typeof nameValue === 'string') {
          activityName = nameValue;
        } else if (nameValue && typeof nameValue === 'object' && nameValue._) {
          activityName = nameValue._;
        }
      }
    }

    // Extract launch element if present
    if (launchElement) {
      const launchArray = Array.isArray(launchElement) ? launchElement : [launchElement];
      for (const launch of launchArray) {
        let launchPath = launch;
        if (typeof launch === 'object' && launch._) {
          launchPath = launch._;
        } else if (typeof launch === 'object') {
          // Try to extract text content
          continue; // Skip if we can't extract a path
        }

        if (typeof launchPath === 'string' && launchPath.trim()) {
          // Skip absolute URLs (external resources)
          if (launchPath.startsWith('http://') || launchPath.startsWith('https://')) {
            continue;
          }

          // Normalize to forward slashes
          const normalizedPath = launchPath.replace(/\\/g, '/').trim();

          // Add to entry points and SCOs
          if (!entryPoints.includes(normalizedPath)) {
            entryPoints.push(normalizedPath);
          }

          scos.push({
            id: activityId || `activity-${scos.length}`,
            title: activityName,
            entryFile: normalizedPath,
          });
        }
      }
    }
  }

  // Validate that we found at least one launchable activity
  if (entryPoints.length === 0) {
    return {
      errors: ['xAPI package has no launchable activities'],
    };
  }

  return {
    entryPoints,
    scos,
    manifest: {
      version: 'xapi',
      tincantPackageType: 'tincan',
      activitiesCount: activities.length,
      launchableCount: entryPoints.length,
    },
  };
}

/**
 * Process attribute names (placeholder for xml2js compatibility)
 */
function fixAttrCase(name) {
  return name;
}

module.exports = {
  parseXapiPackage,
};
