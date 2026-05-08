/**
 * Shared assertion helpers used by per-fixer tests under test/fixers/.
 *
 * Patch field expectations match PRD v4 § "Manifest schema". The fixer's
 * apply() emits patches WITHOUT an `id` (the manifest assigns ids); these
 * helpers therefore tolerate a missing id but require every other field.
 */

import { expect } from 'vitest';

export const REQUIRED_PATCH_FIELDS = [
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

export function assertPatchShape(patch, expected = {}) {
  for (const f of REQUIRED_PATCH_FIELDS) {
    expect(patch, `patch missing ${f}`).toHaveProperty(f);
  }
  expect(patch.tier).toBe('safe');
  expect(patch.status).toBe('applied');
  expect(patch.reversible).toBe(true);
  expect(patch.provenance).toMatchObject({ source: 'deterministic' });
  expect(typeof patch.provenance.timestamp).toBe('string');
  expect(patch.range).toMatchObject({
    startLine: expect.any(Number),
    startCol: expect.any(Number),
    endLine: expect.any(Number),
    endCol: expect.any(Number)
  });
  expect(typeof patch.before).toBe('string');
  expect(typeof patch.after).toBe('string');
  expect(patch.before).not.toBe(patch.after);

  if (expected.fixer) expect(patch.fixer).toBe(expected.fixer);
  if (expected.criterion !== undefined) expect(patch.criterion).toBe(expected.criterion);
  if (expected.confidence) expect(patch.confidence).toBe(expected.confidence);
  if (expected.file) expect(patch.file).toBe(expected.file);
}

export async function assertRoundTrip(fixer, file, applyResult) {
  let cur = applyResult.newContent;
  for (const patch of [...applyResult.patches].reverse()) {
    const r = await fixer.revert({ path: file.path, content: cur }, patch);
    cur = r.newContent;
  }
  expect(cur).toBe(file.content);
}

export async function assertFixShimLegacy(fixer, file, violations) {
  const result = await fixer.fix(file, violations);
  expect(result).toHaveProperty('changed');
  expect(result).toHaveProperty('newContent');
  expect(result).toHaveProperty('log');
  expect(result).not.toHaveProperty('patches');
  return result;
}
