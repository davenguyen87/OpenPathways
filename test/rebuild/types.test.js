import { describe, it, expect } from 'vitest';
import { buildPatch, linkPatchToTransform } from '../../src/rebuild/types.js';

function samplePatch() {
  const content = '<html>\n  <body>\n    <img src="x.gif">\n  </body>\n</html>\n';
  const original = '<img src="x.gif">';
  const replacement = '<img src="x.gif" alt="">';
  const offset = content.indexOf(original);
  return buildPatch({
    fixer: 'add-alt-decorative',
    criterion: '1.1.1',
    confidence: 'definitive',
    file: 'shared/page.html',
    content,
    originalOffset: offset,
    originalText: original,
    replacementText: replacement,
    rationale: 'decorative image'
  });
}

describe('linkPatchToTransform', () => {
  it('returns a new patch with transformId set', () => {
    const p = samplePatch();
    const linked = linkPatchToTransform(p, 'transform-0001');
    expect(linked.transformId).toBe('transform-0001');
  });

  it('does not mutate the input patch', () => {
    const p = samplePatch();
    const before = JSON.stringify(p);
    const linked = linkPatchToTransform(p, 'transform-0007');
    expect(JSON.stringify(p)).toBe(before);
    expect(p).not.toHaveProperty('transformId');
    expect(linked).not.toBe(p);
  });

  it('preserves every original field on the output', () => {
    const p = samplePatch();
    const linked = linkPatchToTransform(p, 'transform-0042');
    for (const key of Object.keys(p)) {
      expect(linked[key]).toEqual(p[key]);
    }
  });

  it('throws when transformId is empty or non-string', () => {
    const p = samplePatch();
    expect(() => linkPatchToTransform(p, '')).toThrow(/transformId/);
    expect(() => linkPatchToTransform(p, 42)).toThrow(/transformId/);
    expect(() => linkPatchToTransform(p, null)).toThrow(/transformId/);
  });

  it('throws when patch is not an object', () => {
    expect(() => linkPatchToTransform(null, 'transform-0001')).toThrow(/patch/);
    expect(() => linkPatchToTransform('hello', 'transform-0001')).toThrow(/patch/);
    expect(() => linkPatchToTransform([], 'transform-0001')).toThrow(/patch/);
  });
});
