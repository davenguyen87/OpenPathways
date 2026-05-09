import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  parseManifest,
  serializeManifest,
  splitResource,
  validateManifest,
  _detectScormVersion
} from '../../src/lib/manifest-xml-editor.js';

const MANIFESTS_DIR = path.resolve(__dirname, '../fixtures/manifests');

function readFixture(name) {
  return fs.readFileSync(path.join(MANIFESTS_DIR, name), 'utf8');
}

describe('parseManifest', () => {
  it('parses a SCORM 1.2 manifest into an AST', async () => {
    const xml = readFixture('scorm12-simple.xml');
    const parsed = await parseManifest(xml);
    expect(parsed).toHaveProperty('ast');
    expect(parsed.ast.manifest).toBeTruthy();
    expect(parsed.ast.manifest.$.identifier).toBe('com.example.course.simple');
  });

  it('parses a SCORM 2004 manifest with imsss namespace', async () => {
    const xml = readFixture('scorm2004-simple.xml');
    const parsed = await parseManifest(xml);
    expect(parsed.ast.manifest.$['xmlns:imsss']).toBe('http://www.imsglobal.org/xsd/imsss');
  });

  it('detects SCORM 1.2 vs 2004 version', async () => {
    const v12 = await parseManifest(readFixture('scorm12-simple.xml'));
    const v2004 = await parseManifest(readFixture('scorm2004-simple.xml'));
    const r12 = validateManifest(v12);
    const r2004 = validateManifest(v2004);
    expect(r12.version).toBe('scorm12');
    expect(r2004.version).toBe('scorm2004');
  });

  it('throws on empty input', async () => {
    await expect(parseManifest('')).rejects.toThrow();
  });

  it('throws on malformed XML', async () => {
    await expect(parseManifest('<manifest><unclosed>')).rejects.toThrow(/invalid XML/);
  });
});

describe('serializeManifest — round-trip determinism', () => {
  it('returns the original string byte-equal when no edits occur', async () => {
    for (const name of ['scorm12-simple.xml', 'scorm12-multi.xml', 'scorm2004-simple.xml']) {
      const xml = readFixture(name);
      const parsed = await parseManifest(xml);
      const out = serializeManifest(parsed);
      expect(out).toBe(xml);
    }
  });

  it('produces AST-equivalent output after a parse(serialize(parse(x))) cycle', async () => {
    const xml = readFixture('scorm12-multi.xml');
    const a = await parseManifest(xml);
    const serialized = serializeManifest(a);
    const b = await parseManifest(serialized);
    // Drop the wrapper symbols when comparing — only the AST matters.
    expect(b.ast).toEqual(a.ast);
  });

  it('preserves namespace declarations and xsi:schemaLocation byte-equal on no-op', async () => {
    const xml = readFixture('scorm12-simple.xml');
    const parsed = await parseManifest(xml);
    const out = serializeManifest(parsed);
    expect(out).toContain('xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"');
    expect(out).toContain('xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"');
    expect(out).toContain('xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd"');
  });
});

describe('splitResource', () => {
  it('replaces a single resource with N resources and updates the matching item', async () => {
    const xml = readFixture('scorm12-simple.xml');
    const parsed = await parseManifest(xml);
    const splits = [
      { identifier: 'RES-LESSON-PART-1', href: 'lesson-part-1.html', files: ['lesson-part-1.html'], title: 'Lesson 1 (Part 1 of 3)' },
      { identifier: 'RES-LESSON-PART-2', href: 'lesson-part-2.html', files: ['lesson-part-2.html'], title: 'Lesson 1 (Part 2 of 3)' },
      { identifier: 'RES-LESSON-PART-3', href: 'lesson-part-3.html', files: ['lesson-part-3.html'], title: 'Lesson 1 (Part 3 of 3)' }
    ];
    splitResource(parsed, 'RES-LESSON', splits);

    const result = validateManifest(parsed);
    expect(result.valid).toBe(true);

    // 3 resources now, none of which is the original.
    const resources = parsed.ast.manifest.resources[0].resource;
    expect(resources).toHaveLength(3);
    expect(resources.map((r) => r.$.identifier)).toEqual(splits.map((s) => s.identifier));

    // 3 items in the organization, in order, with new titles and references.
    const items = parsed.ast.manifest.organizations[0].organization[0].item;
    expect(items).toHaveLength(3);
    expect(items[0].$.identifierref).toBe('RES-LESSON-PART-1');
    expect(items[2].$.identifierref).toBe('RES-LESSON-PART-3');
    expect(items[0].title).toEqual(['Lesson 1 (Part 1 of 3)']);
  });

  it('preserves adlcp:masteryscore on every split item', async () => {
    const xml = readFixture('scorm12-simple.xml');
    const parsed = await parseManifest(xml);
    splitResource(parsed, 'RES-LESSON', [
      { identifier: 'a', href: 'a.html', files: ['a.html'], title: 'A' },
      { identifier: 'b', href: 'b.html', files: ['b.html'], title: 'B' }
    ]);
    const items = parsed.ast.manifest.organizations[0].organization[0].item;
    for (const item of items) {
      expect(item['adlcp:masteryscore']).toBeDefined();
    }
  });

  it('preserves SCO sequence integrity — splits sit in the original item position', async () => {
    const xml = readFixture('scorm12-multi.xml');
    const parsed = await parseManifest(xml);
    splitResource(parsed, 'RES-LESSON', [
      { identifier: 'L1', href: 'l1.html', files: ['l1.html'], title: 'Lesson L1' },
      { identifier: 'L2', href: 'l2.html', files: ['l2.html'], title: 'Lesson L2' }
    ]);
    const items = parsed.ast.manifest.organizations[0].organization[0].item;
    // Original order was: ITEM-INTRO, ITEM-LESSON, ITEM-OUTRO.
    // After split, the ITEM-LESSON slot becomes 2 items: L1, L2.
    expect(items.map((i) => i.$.identifierref)).toEqual(['RES-INTRO', 'L1', 'L2', 'RES-OUTRO']);
  });

  it('throws when the resource identifier is not found', async () => {
    const xml = readFixture('scorm12-simple.xml');
    const parsed = await parseManifest(xml);
    expect(() => splitResource(parsed, 'DOES-NOT-EXIST', [
      { identifier: 'a', href: 'a.html', files: ['a.html'], title: 'A' }
    ])).toThrow(/not found/);
  });

  it('throws on empty splits array', async () => {
    const xml = readFixture('scorm12-simple.xml');
    const parsed = await parseManifest(xml);
    expect(() => splitResource(parsed, 'RES-LESSON', [])).toThrow(/non-empty/);
  });

  it('produces a valid manifest after splitting (validateManifest passes)', async () => {
    const xml = readFixture('scorm12-multi.xml');
    const parsed = await parseManifest(xml);
    splitResource(parsed, 'RES-LESSON', [
      { identifier: 'L1', href: 'l1.html', files: ['l1.html'], title: 'Lesson L1' },
      { identifier: 'L2', href: 'l2.html', files: ['l2.html'], title: 'Lesson L2' }
    ]);
    // Re-serialize and re-parse to check the round-trip stays valid.
    const out = serializeManifest(parsed);
    const reparsed = await parseManifest(out);
    expect(validateManifest(reparsed).valid).toBe(true);
  });
});

describe('validateManifest', () => {
  it('flags a manifest with no <organizations>', async () => {
    const xml = readFixture('invalid-no-organizations.xml');
    const parsed = await parseManifest(xml);
    const result = validateManifest(parsed);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /<organizations>/.test(e))).toBe(true);
  });

  it('passes a clean SCORM 1.2 fixture', async () => {
    const xml = readFixture('scorm12-simple.xml');
    const parsed = await parseManifest(xml);
    const result = validateManifest(parsed);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe('_detectScormVersion', () => {
  it('returns scorm12 for the 1.2 fixture', async () => {
    const parsed = await parseManifest(readFixture('scorm12-simple.xml'));
    expect(_detectScormVersion(parsed.ast)).toBe('scorm12');
  });

  it('returns scorm2004 for the 2004 fixture', async () => {
    const parsed = await parseManifest(readFixture('scorm2004-simple.xml'));
    expect(_detectScormVersion(parsed.ast)).toBe('scorm2004');
  });
});
