/**
 * Scope estimator for Open Pathways v3
 *
 * Computes effort estimates in minutes for individual findings and rolls up
 * at package and library level. Uses calibration tables from
 * config/effort-calibration.json, with built-in defaults as fallback.
 */

const fs = require('fs');
const path = require('path');

/**
 * Default calibration table (used if config/effort-calibration.json is absent)
 * Each triage tier has a default effort (in minutes) and optional per-criterion overrides.
 */
const DEFAULT_CALIBRATION = {
  'auto-fix safe': {
    default: 5,
    byCriterion: {
      '1.1.1': 3,
      '4.1.2': 7
    }
  },
  'auto-fix assisted': {
    default: 12,
    byCriterion: {
      '1.1.1': 10,
      '3.3.2': 15
    }
  },
  'author rework': {
    default: 60,
    byCriterion: {
      '2.4.6': 45,
      '1.4.3': 90
    }
  },
  'content rework': {
    default: 240,
    byCriterion: {
      '1.2.1': 180,
      '1.2.2': 300,
      '1.2.5': 420
    }
  },
  'recommend retire': {
    default: 0
  }
};

/**
 * Load calibration from config/effort-calibration.json if it exists.
 * Falls back to DEFAULT_CALIBRATION if the file is missing.
 * @returns {object} calibration table
 */
function loadCalibration() {
  const configPath = path.join(__dirname, '../../config/effort-calibration.json');
  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      return JSON.parse(content);
    }
  } catch (err) {
    // Silently fall through to default
  }
  return DEFAULT_CALIBRATION;
}

/**
 * Estimate effort in minutes for a single violation.
 *
 * Logic:
 * 1. Look up the violation's triage tag in the calibration table
 * 2. Check if there's a per-criterion override (byCriterion[criterion])
 * 3. Otherwise use the tier's default value
 * 4. Return the effort as an integer (minutes)
 *
 * @param {object} violation - { triage, criterion, ... }
 * @param {object} calibration - calibration table (uses loaded default if omitted)
 * @returns {number} effort in minutes
 */
function estimateEffort(violation, calibration) {
  const cal = calibration || loadCalibration();
  const { triage, criterion } = violation;

  if (!triage) {
    // Triage not set; default to 'author rework'
    triage = 'author rework';
  }

  const tierConfig = cal[triage] || cal['author rework'];
  if (!tierConfig) {
    // Fallback
    return 60;
  }

  // Check for criterion-specific override
  if (criterion && tierConfig.byCriterion?.[criterion] !== undefined) {
    return Math.round(tierConfig.byCriterion[criterion]);
  }

  // Use tier default
  return Math.round(tierConfig.default || 60);
}

/**
 * Estimate effort for all violations.
 * Mutates each violation to add an `effortMinutes` field.
 *
 * @param {array} violations - array of violation objects
 * @param {object} calibration - calibration table (optional)
 * @returns {array} the same violations array (mutated)
 */
function estimateAllEfforts(violations, calibration) {
  const cal = calibration || loadCalibration();
  for (const violation of violations) {
    violation.effortMinutes = estimateEffort(violation, cal);
  }
  return violations;
}

/**
 * Roll up efforts at package level.
 *
 * @param {array} violations - violations with effortMinutes already set
 * @returns {object} {
 *   totalMinutes: number,
 *   totalHours: number (decimal),
 *   byTriage: { 'auto-fix safe': N, 'auto-fix assisted': N, ... },
 *   byCriterion: { '1.1.1': N, '2.4.2': N, ... }
 * }
 */
function rollupPackage(violations) {
  const byTriage = {};
  const byCriterion = {};
  let totalMinutes = 0;

  for (const violation of violations) {
    const effort = violation.effortMinutes || 0;
    totalMinutes += effort;

    const triage = violation.triage || 'author rework';
    byTriage[triage] = (byTriage[triage] || 0) + effort;

    const criterion = violation.criterion || 'unknown';
    byCriterion[criterion] = (byCriterion[criterion] || 0) + effort;
  }

  return {
    totalMinutes,
    totalHours: +(totalMinutes / 60).toFixed(1),
    byTriage,
    byCriterion
  };
}

/**
 * Roll up efforts at library level (multiple packages).
 *
 * Includes QA re-audit (15% of total) and Migration handoff (8% of total),
 * rounded to nearest 5 minutes as heuristics documented in the PRD.
 *
 * QA re-audit: After all remediation, perform a final sweep to verify fixes
 * didn't introduce new violations and all critical findings were addressed.
 * This is estimated as 15% of the package-level remediation effort.
 *
 * Migration handoff: Effort to hand off the completed and verified packages
 * to the migration team, including documentation, hand-written notes, and
 * migration-specific QA. Estimated as 8% of total remediation effort.
 *
 * @param {array} packageRollups - array of results from rollupPackage()
 * @returns {object} {
 *   totalMinutes: number,
 *   totalHours: number (decimal),
 *   byTriage: { 'Auto-fix tier': N, 'Author rework': N, ... },
 *   byCategory: { 'Auto-fix tier': N, 'Author rework': N, 'Content rework': N, 'QA re-audit': N, 'Migration handoff': N }
 * }
 */
function rollupLibrary(packageRollups) {
  const byTriage = {
    'auto-fix safe': 0,
    'auto-fix assisted': 0,
    'author rework': 0,
    'content rework': 0,
    'recommend retire': 0
  };

  let remediationTotalMinutes = 0;

  // Aggregate all package rollups
  for (const pkg of packageRollups) {
    if (pkg.byTriage) {
      for (const [tier, minutes] of Object.entries(pkg.byTriage)) {
        byTriage[tier] = (byTriage[tier] || 0) + minutes;
      }
    }
    remediationTotalMinutes += pkg.totalMinutes || 0;
  }

  // Compute QA re-audit and migration handoff
  const qaReauditMinutes = Math.round((remediationTotalMinutes * 0.15) / 5) * 5;
  const migrationHandoffMinutes = Math.round((remediationTotalMinutes * 0.08) / 5) * 5;

  const totalMinutes = remediationTotalMinutes + qaReauditMinutes + migrationHandoffMinutes;

  // Build the byCategory map (consultant-facing labels)
  const byCategory = {
    'Auto-fix tier': byTriage['auto-fix safe'] + byTriage['auto-fix assisted'],
    'Author rework': byTriage['author rework'],
    'Content rework': byTriage['content rework'],
    'QA re-audit': qaReauditMinutes,
    'Migration handoff': migrationHandoffMinutes
  };

  return {
    totalMinutes,
    totalHours: +(totalMinutes / 60).toFixed(1),
    byTriage,
    byCategory
  };
}

module.exports = {
  estimateEffort,
  estimateAllEfforts,
  rollupPackage,
  rollupLibrary,
  loadCalibration,
  DEFAULT_CALIBRATION
};
