/**
 * RebuildManifest — create, mutate, validate, read, write.
 *
 * The schema is the contract laid out in PRD v4 § "Manifest schema".
 * Validation is hand-written against that schema (no third-party validator).
 *
 * @typedef {import('./types').Patch} Patch
 * @typedef {import('./types').RebuildManifest} RebuildManifest
 * @typedef {import('./types').DeferredFinding} DeferredFinding
 * @typedef {import('./types').VerificationCounts} VerificationCounts
 */

const fs = require('fs');

const SCHEMA_VERSION = '1.0.0';
const TOOL_NAME = 'prism';
const TOOL_VERSION = '4.0.0';

const VALID_MODES = ['safe', 'assisted', 'full'];
const VALID_STANDARDS = ['wcag21', 'wcag22'];
const VALID_TIERS = ['safe', 'assisted', 'full'];
const VALID_PROVENANCE_SOURCES = ['deterministic', 'llm', 'rule-based'];
const VALID_CONFIDENCES = ['definitive', 'likely', 'needs-review'];
const VALID_STATUSES = ['applied', 'reverted', 'rejected'];

const TOP_LEVEL_KEYS = [
  'schemaVersion',
  'engagementId',
  'packageName',
  'inputZipSha256',
  'outputZipSha256',
  'mode',
  'standard',
  'createdAt',
  'tool',
  'patches',
  'deferred',
  'verification'
];

const OPTIONAL_TOP_LEVEL_KEYS = ['revertHistory'];

const REVERT_HISTORY_KEYS = ['revertedAt', 'revertedBy', 'patchIds'];

const PATCH_KEYS = [
  'id',
  'fixer',
  'criterion',
  'triage',
  'tier',
  'confidence',
  'provenance',
  'file',
  'range',
  'before',
  'after',
  'rationale',
  'reversible',
  'status'
];

const RANGE_KEYS = ['startLine', 'startCol', 'endLine', 'endCol'];
const VERIFY_COUNT_KEYS = ['violations', 'criteriaFailed', 'section508Failed'];
const DEFERRED_KEYS = ['criterion', 'triage', 'reason', 'file', 'line'];

/**
 * Build a fresh manifest. Required: engagementId, packageName, inputZipSha256.
 * Defaults: mode=safe, standard=wcag22, outputZipSha256='', createdAt=now.
 *
 * @param {Object} opts
 * @returns {RebuildManifest}
 */
function createManifest(opts) {
  const o = opts || {};
  if (!o.engagementId) throw new Error('engagementId is required');
  if (!o.packageName) throw new Error('packageName is required');
  if (!o.inputZipSha256) throw new Error('inputZipSha256 is required');

  const mode = o.mode || 'safe';
  const standard = o.standard || 'wcag22';
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`mode must be one of ${VALID_MODES.join('|')}`);
  }
  if (!VALID_STANDARDS.includes(standard)) {
    throw new Error(`standard must be one of ${VALID_STANDARDS.join('|')}`);
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    engagementId: o.engagementId,
    packageName: o.packageName,
    inputZipSha256: o.inputZipSha256,
    outputZipSha256: o.outputZipSha256 || '',
    mode,
    standard,
    createdAt: o.createdAt || new Date().toISOString(),
    tool: { name: o.toolName || TOOL_NAME, version: o.toolVersion || TOOL_VERSION },
    patches: [],
    deferred: [],
    verification: {
      before: { violations: 0, criteriaFailed: 0, section508Failed: 0 },
      after: { violations: 0, criteriaFailed: 0, section508Failed: 0 },
      resolved: 0,
      introduced: 0,
      remaining: 0
    }
  };
}

/**
 * Append a patch and assign it the next sequential id (patch-NNNN).
 * Validates required fields; throws on invalid input. Mutates `manifest`.
 *
 * @param {RebuildManifest} manifest
 * @param {Patch} patch
 * @returns {Patch} the appended patch (with id assigned)
 */
function addPatch(manifest, patch) {
  const seq = manifest.patches.length + 1;
  const id = `patch-${String(seq).padStart(4, '0')}`;
  const full = { ...patch, id };
  const errors = validatePatch(full);
  if (errors.length > 0) {
    throw new Error(`invalid patch: ${errors.join('; ')}`);
  }
  manifest.patches.push(full);
  return full;
}

/**
 * Append a deferred finding. Validates required fields.
 *
 * @param {RebuildManifest} manifest
 * @param {DeferredFinding} finding
 */
function addDeferred(manifest, finding) {
  const errors = validateDeferred(finding);
  if (errors.length > 0) {
    throw new Error(`invalid deferred finding: ${errors.join('; ')}`);
  }
  manifest.deferred.push({ ...finding });
}

/**
 * Populate the verification block. Computes `resolved`, `introduced`,
 * and `remaining` from the before/after counts.
 *
 *   resolved   = max(0, before.violations - after.violations)
 *   introduced = max(0, after.violations - before.violations)
 *   remaining  = after.violations
 *
 * @param {RebuildManifest} manifest
 * @param {VerificationCounts} before
 * @param {VerificationCounts} after
 */
function setVerification(manifest, before, after) {
  for (const k of VERIFY_COUNT_KEYS) {
    if (typeof before[k] !== 'number') {
      throw new Error(`verification.before.${k} must be a number`);
    }
    if (typeof after[k] !== 'number') {
      throw new Error(`verification.after.${k} must be a number`);
    }
  }
  manifest.verification = {
    before: {
      violations: before.violations,
      criteriaFailed: before.criteriaFailed,
      section508Failed: before.section508Failed
    },
    after: {
      violations: after.violations,
      criteriaFailed: after.criteriaFailed,
      section508Failed: after.section508Failed
    },
    resolved: Math.max(0, before.violations - after.violations),
    introduced: Math.max(0, after.violations - before.violations),
    remaining: after.violations
  };
}

/**
 * Serialize a manifest to disk. Pretty-printed (2-space) with deterministic
 * key order matching the PRD schema layout.
 *
 * Refuses to write a manifest with an empty `inputZipSha256` or
 * `outputZipSha256` — both are required for a manifest to be self-describing.
 * Build the manifest in memory, set both hashes after repackaging, and only
 * then call writeManifest.
 *
 * @param {RebuildManifest} manifest
 * @param {string} filePath
 */
function writeManifest(manifest, filePath) {
  const result = validateManifest(manifest);
  if (!result.valid) {
    throw new Error(`cannot write invalid manifest: ${result.errors.join('; ')}`);
  }
  if (!manifest.inputZipSha256) {
    throw new Error('cannot write manifest with empty inputZipSha256');
  }
  if (!manifest.outputZipSha256) {
    throw new Error('cannot write manifest with empty outputZipSha256 — set it after repackaging');
  }
  fs.writeFileSync(filePath, serialize(manifest), 'utf8');
}

/**
 * Load and validate a manifest from disk.
 *
 * @param {string} filePath
 * @returns {RebuildManifest}
 */
function readManifest(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`manifest at ${filePath} is not valid JSON: ${err.message}`);
  }
  const result = validateManifest(parsed);
  if (!result.valid) {
    throw new Error(`invalid manifest at ${filePath}: ${result.errors.join('; ')}`);
  }
  return parsed;
}

/**
 * Pure validator. Returns a structured result; never throws on bad input.
 *
 * @param {*} manifest
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateManifest(manifest) {
  const errors = [];

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { valid: false, errors: ['manifest must be an object'] };
  }

  for (const k of TOP_LEVEL_KEYS) {
    if (!(k in manifest)) {
      errors.push(`missing required field: ${k}`);
    }
  }
  for (const k of Object.keys(manifest)) {
    if (!TOP_LEVEL_KEYS.includes(k) && !OPTIONAL_TOP_LEVEL_KEYS.includes(k)) {
      errors.push(`unknown top-level key: ${k}`);
    }
  }

  if ('schemaVersion' in manifest && typeof manifest.schemaVersion !== 'string') {
    errors.push('schemaVersion must be a string');
  }
  if ('engagementId' in manifest && typeof manifest.engagementId !== 'string') {
    errors.push('engagementId must be a string');
  }
  if ('packageName' in manifest && typeof manifest.packageName !== 'string') {
    errors.push('packageName must be a string');
  }
  if ('inputZipSha256' in manifest && typeof manifest.inputZipSha256 !== 'string') {
    errors.push('inputZipSha256 must be a string');
  }
  if ('outputZipSha256' in manifest && typeof manifest.outputZipSha256 !== 'string') {
    errors.push('outputZipSha256 must be a string');
  }
  if ('mode' in manifest && !VALID_MODES.includes(manifest.mode)) {
    errors.push(`mode must be one of ${VALID_MODES.join('|')}`);
  }
  if ('standard' in manifest && !VALID_STANDARDS.includes(manifest.standard)) {
    errors.push(`standard must be one of ${VALID_STANDARDS.join('|')}`);
  }
  if ('createdAt' in manifest && typeof manifest.createdAt !== 'string') {
    errors.push('createdAt must be a string');
  }

  if ('tool' in manifest) {
    if (!manifest.tool || typeof manifest.tool !== 'object' || Array.isArray(manifest.tool)) {
      errors.push('tool must be an object');
    } else {
      if (typeof manifest.tool.name !== 'string') errors.push('tool.name must be a string');
      if (typeof manifest.tool.version !== 'string') errors.push('tool.version must be a string');
    }
  }

  if ('patches' in manifest) {
    if (!Array.isArray(manifest.patches)) {
      errors.push('patches must be an array');
    } else {
      manifest.patches.forEach((p, i) => {
        for (const e of validatePatch(p)) {
          errors.push(`patches[${i}]: ${e}`);
        }
      });
    }
  }

  if ('deferred' in manifest) {
    if (!Array.isArray(manifest.deferred)) {
      errors.push('deferred must be an array');
    } else {
      manifest.deferred.forEach((d, i) => {
        for (const e of validateDeferred(d)) {
          errors.push(`deferred[${i}]: ${e}`);
        }
      });
    }
  }

  if ('verification' in manifest) {
    for (const e of validateVerification(manifest.verification)) {
      errors.push(`verification: ${e}`);
    }
  }

  if ('revertHistory' in manifest) {
    if (!Array.isArray(manifest.revertHistory)) {
      errors.push('revertHistory must be an array');
    } else {
      manifest.revertHistory.forEach((entry, i) => {
        for (const e of validateRevertHistoryEntry(entry)) {
          errors.push(`revertHistory[${i}]: ${e}`);
        }
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * @param {*} entry
 * @returns {string[]}
 */
function validateRevertHistoryEntry(entry) {
  const errors = [];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return ['revertHistory entry must be an object'];
  }
  for (const k of REVERT_HISTORY_KEYS) {
    if (!(k in entry)) errors.push(`missing required field: ${k}`);
  }
  if ('revertedAt' in entry && typeof entry.revertedAt !== 'string') {
    errors.push('revertedAt must be a string');
  }
  if ('revertedBy' in entry && typeof entry.revertedBy !== 'string') {
    errors.push('revertedBy must be a string');
  }
  if ('patchIds' in entry) {
    if (!Array.isArray(entry.patchIds)) {
      errors.push('patchIds must be an array');
    } else {
      entry.patchIds.forEach((id, i) => {
        if (typeof id !== 'string') errors.push(`patchIds[${i}] must be a string`);
      });
    }
  }
  return errors;
}

/**
 * @param {*} patch
 * @returns {string[]} error messages, empty if valid
 */
function validatePatch(patch) {
  const errors = [];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return ['patch must be an object'];
  }

  for (const k of PATCH_KEYS) {
    if (!(k in patch)) errors.push(`missing required field: ${k}`);
  }

  if (patch.id !== undefined && typeof patch.id !== 'string') {
    errors.push('id must be a string');
  } else if (typeof patch.id === 'string' && !/^patch-\d{4}$/.test(patch.id)) {
    errors.push('id must match patch-NNNN');
  }
  if ('fixer' in patch && typeof patch.fixer !== 'string') errors.push('fixer must be a string');
  if ('criterion' in patch && typeof patch.criterion !== 'string') errors.push('criterion must be a string');
  if ('triage' in patch && typeof patch.triage !== 'string') errors.push('triage must be a string');
  if ('tier' in patch && !VALID_TIERS.includes(patch.tier)) {
    errors.push(`tier must be one of ${VALID_TIERS.join('|')}`);
  }
  if ('confidence' in patch && !VALID_CONFIDENCES.includes(patch.confidence)) {
    errors.push(`confidence must be one of ${VALID_CONFIDENCES.join('|')}`);
  }
  if ('provenance' in patch) {
    const prov = patch.provenance;
    if (!prov || typeof prov !== 'object') {
      errors.push('provenance must be an object');
    } else {
      if (!VALID_PROVENANCE_SOURCES.includes(prov.source)) {
        errors.push(`provenance.source must be one of ${VALID_PROVENANCE_SOURCES.join('|')}`);
      }
      if (typeof prov.timestamp !== 'string') errors.push('provenance.timestamp must be a string');
    }
  }
  if ('file' in patch && typeof patch.file !== 'string') errors.push('file must be a string');
  if ('range' in patch) {
    const r = patch.range;
    if (!r || typeof r !== 'object') {
      errors.push('range must be an object');
    } else {
      for (const rk of RANGE_KEYS) {
        if (typeof r[rk] !== 'number') errors.push(`range.${rk} must be a number`);
      }
    }
  }
  if ('before' in patch && typeof patch.before !== 'string') errors.push('before must be a string');
  if ('after' in patch && typeof patch.after !== 'string') errors.push('after must be a string');
  if ('rationale' in patch && typeof patch.rationale !== 'string') errors.push('rationale must be a string');
  if ('reversible' in patch && typeof patch.reversible !== 'boolean') errors.push('reversible must be a boolean');
  if ('status' in patch && !VALID_STATUSES.includes(patch.status)) {
    errors.push(`status must be one of ${VALID_STATUSES.join('|')}`);
  }
  return errors;
}

/**
 * @param {*} d
 * @returns {string[]}
 */
function validateDeferred(d) {
  const errors = [];
  if (!d || typeof d !== 'object' || Array.isArray(d)) {
    return ['deferred finding must be an object'];
  }
  for (const k of DEFERRED_KEYS) {
    if (!(k in d)) errors.push(`missing required field: ${k}`);
  }
  if ('criterion' in d && typeof d.criterion !== 'string') errors.push('criterion must be a string');
  if ('triage' in d && typeof d.triage !== 'string') errors.push('triage must be a string');
  if ('reason' in d && typeof d.reason !== 'string') errors.push('reason must be a string');
  if ('file' in d && typeof d.file !== 'string') errors.push('file must be a string');
  if ('line' in d && typeof d.line !== 'number') errors.push('line must be a number');
  return errors;
}

/**
 * @param {*} v
 * @returns {string[]}
 */
function validateVerification(v) {
  const errors = [];
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return ['verification must be an object'];
  }
  const verifyKeys = ['before', 'after', 'resolved', 'introduced', 'remaining'];
  for (const k of verifyKeys) {
    if (!(k in v)) errors.push(`missing required field: ${k}`);
  }
  for (const side of ['before', 'after']) {
    if (v[side] !== undefined) {
      if (!v[side] || typeof v[side] !== 'object') {
        errors.push(`${side} must be an object`);
      } else {
        for (const ck of VERIFY_COUNT_KEYS) {
          if (typeof v[side][ck] !== 'number') {
            errors.push(`${side}.${ck} must be a number`);
          }
        }
      }
    }
  }
  for (const k of ['resolved', 'introduced', 'remaining']) {
    if (k in v && typeof v[k] !== 'number') errors.push(`${k} must be a number`);
  }
  return errors;
}

function serialize(manifest) {
  const ordered = {
    schemaVersion: manifest.schemaVersion,
    engagementId: manifest.engagementId,
    packageName: manifest.packageName,
    inputZipSha256: manifest.inputZipSha256,
    outputZipSha256: manifest.outputZipSha256,
    mode: manifest.mode,
    standard: manifest.standard,
    createdAt: manifest.createdAt,
    tool: { name: manifest.tool.name, version: manifest.tool.version },
    patches: manifest.patches.map((p) => orderedPatch(p)),
    deferred: manifest.deferred.map((d) => ({
      criterion: d.criterion,
      triage: d.triage,
      reason: d.reason,
      file: d.file,
      line: d.line
    })),
    verification: orderedVerification(manifest.verification)
  };
  if (Array.isArray(manifest.revertHistory) && manifest.revertHistory.length > 0) {
    ordered.revertHistory = manifest.revertHistory.map((e) => ({
      revertedAt: e.revertedAt,
      revertedBy: e.revertedBy,
      patchIds: [...e.patchIds]
    }));
  }
  return JSON.stringify(ordered, null, 2);
}

function orderedPatch(p) {
  const prov = {
    source: p.provenance.source,
    timestamp: p.provenance.timestamp
  };
  if (p.provenance.model !== undefined) prov.model = p.provenance.model;
  if (p.provenance.promptHash !== undefined) prov.promptHash = p.provenance.promptHash;
  if (p.provenance.modelConfidence !== undefined) prov.modelConfidence = p.provenance.modelConfidence;
  return {
    id: p.id,
    fixer: p.fixer,
    criterion: p.criterion,
    triage: p.triage,
    tier: p.tier,
    confidence: p.confidence,
    provenance: prov,
    file: p.file,
    range: {
      startLine: p.range.startLine,
      startCol: p.range.startCol,
      endLine: p.range.endLine,
      endCol: p.range.endCol
    },
    before: p.before,
    after: p.after,
    rationale: p.rationale,
    reversible: p.reversible,
    status: p.status
  };
}

function orderedVerification(v) {
  return {
    before: {
      violations: v.before.violations,
      criteriaFailed: v.before.criteriaFailed,
      section508Failed: v.before.section508Failed
    },
    after: {
      violations: v.after.violations,
      criteriaFailed: v.after.criteriaFailed,
      section508Failed: v.after.section508Failed
    },
    resolved: v.resolved,
    introduced: v.introduced,
    remaining: v.remaining
  };
}

module.exports = {
  createManifest,
  addPatch,
  addDeferred,
  setVerification,
  writeManifest,
  readManifest,
  validateManifest,
  validatePatch,
  SCHEMA_VERSION,
  TOOL_NAME,
  TOOL_VERSION
};
