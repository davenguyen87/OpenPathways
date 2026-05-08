import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import {
  createManifest,
  addPatch,
  addDeferred,
  setVerification,
  writeManifest,
  readManifest,
  validateManifest,
  validatePatch,
  SCHEMA_VERSION
} from '../../src/rebuild/manifest.js';
import { buildPatch } from '../../src/rebuild/types.js';

function freshManifest() {
  return createManifest({
    engagementId: 'acme-2026',
    packageName: 'compliance-101.zip',
    inputZipSha256: 'a'.repeat(64),
    createdAt: '2026-05-07T14:22:11Z'
  });
}

function finalizedManifest() {
  const m = freshManifest();
  m.outputZipSha256 = 'b'.repeat(64);
  return m;
}

function freshPatch(overrides = {}) {
  const content = '<html>\n  <body>\n    <img src="x.gif">\n  </body>\n</html>\n';
  const original = '<img src="x.gif">';
  const replacement = '<img src="x.gif" alt="">';
  const offset = content.indexOf(original);
  return {
    ...buildPatch({
      fixer: 'add-alt-decorative',
      criterion: '1.1.1',
      confidence: 'definitive',
      file: 'shared/page.html',
      content,
      originalOffset: offset,
      originalText: original,
      replacementText: replacement,
      rationale: 'decorative image'
    }),
    ...overrides
  };
}

describe('createManifest', () => {
  it('returns a manifest that passes validateManifest', () => {
    const m = freshManifest();
    expect(validateManifest(m)).toEqual({ valid: true, errors: [] });
  });

  it('populates schemaVersion, tool, and zero-state defaults', () => {
    const m = freshManifest();
    expect(m.schemaVersion).toBe(SCHEMA_VERSION);
    expect(m.tool).toEqual({ name: 'prism', version: '4.0.0' });
    expect(m.patches).toEqual([]);
    expect(m.deferred).toEqual([]);
    expect(m.verification.before.violations).toBe(0);
    expect(m.mode).toBe('safe');
    expect(m.standard).toBe('wcag22');
    expect(m.outputZipSha256).toBe('');
  });

  it('throws when engagementId is missing', () => {
    expect(() =>
      createManifest({ packageName: 'p.zip', inputZipSha256: 'x' })
    ).toThrow(/engagementId/);
  });

  it('throws when packageName is missing', () => {
    expect(() =>
      createManifest({ engagementId: 'e', inputZipSha256: 'x' })
    ).toThrow(/packageName/);
  });

  it('throws when inputZipSha256 is missing', () => {
    expect(() =>
      createManifest({ engagementId: 'e', packageName: 'p.zip' })
    ).toThrow(/inputZipSha256/);
  });

  it('rejects an unknown mode', () => {
    expect(() =>
      createManifest({
        engagementId: 'e',
        packageName: 'p.zip',
        inputZipSha256: 'x',
        mode: 'banana'
      })
    ).toThrow(/mode/);
  });
});

describe('addPatch', () => {
  it('assigns sequential ids in patch-NNNN format', () => {
    const m = freshManifest();
    const p1 = addPatch(m, freshPatch());
    const p2 = addPatch(m, freshPatch());
    const p3 = addPatch(m, freshPatch());
    expect(p1.id).toBe('patch-0001');
    expect(p2.id).toBe('patch-0002');
    expect(p3.id).toBe('patch-0003');
    expect(m.patches.map((p) => p.id)).toEqual(['patch-0001', 'patch-0002', 'patch-0003']);
  });

  it('throws when a required field is missing', () => {
    const m = freshManifest();
    const incomplete = { ...freshPatch() };
    delete incomplete.criterion;
    expect(() => addPatch(m, incomplete)).toThrow(/criterion/);
  });

  it('throws when tier is invalid', () => {
    const m = freshManifest();
    expect(() => addPatch(m, freshPatch({ tier: 'banana' }))).toThrow(/tier/);
  });

  it('throws when range coordinates are missing', () => {
    const m = freshManifest();
    const bad = freshPatch();
    bad.range = { startLine: 1, startCol: 1 };
    expect(() => addPatch(m, bad)).toThrow(/range\.endLine|range\.endCol/);
  });
});

describe('addDeferred', () => {
  it('appends a deferred finding', () => {
    const m = freshManifest();
    addDeferred(m, {
      criterion: '1.1.1',
      triage: 'auto-fix assisted',
      reason: 'tier=assisted not enabled',
      file: 'page.html',
      line: 22
    });
    expect(m.deferred).toHaveLength(1);
    expect(m.deferred[0].file).toBe('page.html');
  });

  it('throws when a required field is missing', () => {
    const m = freshManifest();
    expect(() =>
      addDeferred(m, {
        criterion: '1.1.1',
        triage: 'auto-fix assisted',
        reason: 'x',
        line: 22
      })
    ).toThrow(/file/);
  });
});

describe('setVerification', () => {
  it('computes resolved, introduced, and remaining', () => {
    const m = freshManifest();
    setVerification(
      m,
      { violations: 47, criteriaFailed: 12, section508Failed: 5 },
      { violations: 9, criteriaFailed: 4, section508Failed: 1 }
    );
    expect(m.verification.resolved).toBe(38);
    expect(m.verification.introduced).toBe(0);
    expect(m.verification.remaining).toBe(9);
  });

  it('clamps resolved at 0 when after > before', () => {
    const m = freshManifest();
    setVerification(
      m,
      { violations: 5, criteriaFailed: 2, section508Failed: 1 },
      { violations: 8, criteriaFailed: 3, section508Failed: 2 }
    );
    expect(m.verification.resolved).toBe(0);
    expect(m.verification.introduced).toBe(3);
    expect(m.verification.remaining).toBe(8);
  });

  it('throws on non-numeric counts', () => {
    const m = freshManifest();
    expect(() =>
      setVerification(
        m,
        { violations: 'lots', criteriaFailed: 0, section508Failed: 0 },
        { violations: 0, criteriaFailed: 0, section508Failed: 0 }
      )
    ).toThrow(/number/);
  });
});

describe('writeManifest + readManifest', () => {
  it('round-trips a populated manifest', () => {
    const m = finalizedManifest();
    addPatch(m, freshPatch());
    addDeferred(m, {
      criterion: '1.1.1',
      triage: 'auto-fix assisted',
      reason: 'deferred',
      file: 'p.html',
      line: 1
    });
    setVerification(
      m,
      { violations: 1, criteriaFailed: 1, section508Failed: 0 },
      { violations: 0, criteriaFailed: 0, section508Failed: 0 }
    );

    const tmp = path.join(os.tmpdir(), `prism-manifest-${Date.now()}.json`);
    try {
      writeManifest(m, tmp);
      const loaded = readManifest(tmp);
      expect(loaded).toEqual(JSON.parse(fs.readFileSync(tmp, 'utf8')));
      expect(loaded.patches[0].id).toBe('patch-0001');
      expect(loaded.verification.resolved).toBe(1);
      expect(loaded.deferred[0].file).toBe('p.html');
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    }
  });

  it('refuses to write a manifest with an empty outputZipSha256', () => {
    const m = freshManifest(); // outputZipSha256 still ''
    const tmp = path.join(os.tmpdir(), `prism-manifest-empty-out-${Date.now()}.json`);
    try {
      expect(() => writeManifest(m, tmp)).toThrow(/outputZipSha256/);
      expect(fs.existsSync(tmp)).toBe(false);
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    }
  });

  it('emits keys in the PRD-specified order', () => {
    const m = finalizedManifest();
    const tmp = path.join(os.tmpdir(), `prism-manifest-order-${Date.now()}.json`);
    try {
      writeManifest(m, tmp);
      const raw = fs.readFileSync(tmp, 'utf8');
      const expected = [
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
      let cursor = 0;
      for (const k of expected) {
        const idx = raw.indexOf(`"${k}"`, cursor);
        expect(idx, `${k} missing or out of order`).toBeGreaterThanOrEqual(cursor);
        cursor = idx;
      }
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    }
  });

  it('readManifest throws on invalid JSON', () => {
    const tmp = path.join(os.tmpdir(), `prism-manifest-bad-${Date.now()}.json`);
    fs.writeFileSync(tmp, '{ this is not json', 'utf8');
    try {
      expect(() => readManifest(tmp)).toThrow(/JSON/);
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    }
  });

  it('readManifest throws on schema-invalid content', () => {
    const tmp = path.join(os.tmpdir(), `prism-manifest-schema-${Date.now()}.json`);
    fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: '1.0.0' }), 'utf8');
    try {
      expect(() => readManifest(tmp)).toThrow(/missing required field/);
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    }
  });
});

describe('validateManifest', () => {
  const requiredTopLevel = [
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

  it.each(requiredTopLevel)('produces a specific error when %s is missing', (field) => {
    const m = freshManifest();
    delete m[field];
    const result = validateManifest(m);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes(field))).toBe(true);
  });

  it('rejects unknown top-level keys', () => {
    const m = freshManifest();
    m.bonusKey = 'extra';
    const result = validateManifest(m);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('unknown top-level key: bonusKey'))).toBe(true);
  });

  it('rejects non-object input gracefully (no throw)', () => {
    expect(validateManifest(null).valid).toBe(false);
    expect(validateManifest('hello').valid).toBe(false);
    expect(validateManifest([]).valid).toBe(false);
  });

  it('rejects an invalid mode', () => {
    const m = freshManifest();
    m.mode = 'banana';
    const result = validateManifest(m);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('mode'))).toBe(true);
  });

  it('rejects a patch with an out-of-format id', () => {
    const m = freshManifest();
    addPatch(m, freshPatch());
    m.patches[0].id = 'patch-1';
    const result = validateManifest(m);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /patch-NNNN/.test(e))).toBe(true);
  });
});

describe('validatePatch', () => {
  it('passes for a buildPatch result with a manually-set id', () => {
    const p = { ...freshPatch(), id: 'patch-0001' };
    expect(validatePatch(p)).toEqual([]);
  });

  it.each([
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
  ])('flags missing %s', (field) => {
    const p = { ...freshPatch(), id: 'patch-0001' };
    delete p[field];
    const errors = validatePatch(p);
    expect(errors.some((e) => e.includes(field))).toBe(true);
  });
});
