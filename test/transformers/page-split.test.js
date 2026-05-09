import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import transformer from '../../src/transformers/page-split.js';
import { parseManifest, validateManifest } from '../../src/lib/manifest-xml-editor.js';

/* ----- helpers ----- */

function makeWorkDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `prism-page-split-test-${crypto.randomBytes(4).toString('hex')}-`));
  return dir;
}

function writeWorkDir(dir, files) {
  for (const f of files) {
    const full = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, f.content, 'utf8');
  }
}

const SCORM12_MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="com.example.course" version="1.0"
          xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
          xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="ORG-1">
    <organization identifier="ORG-1">
      <title>Test Course</title>
      <item identifier="ITEM-LESSON" identifierref="RES-LESSON">
        <title>Lesson</title>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES-LESSON" type="webcontent" adlcp:scormtype="sco" href="lesson.html">
      <file href="lesson.html"/>
    </resource>
  </resources>
</manifest>
`;

function makeLessonHtmlWithThreeH1s() {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Lesson</title></head>
<body>
<h1>Topic 1</h1>
<p>First section content goes here.</p>
<h1>Topic 2</h1>
<p>Second section content.</p>
<h1>Topic 3</h1>
<p>Third section content.</p>
</body>
</html>
`;
}

function makeContext({ files, opts = {}, parserVersion = 'scorm12', audit = { violations: [] }, workDir = null }) {
  return {
    files: files.map((f) => ({
      ...f,
      size: typeof f.size === 'number' ? f.size : Buffer.byteLength(f.content, 'utf8')
    })),
    parserVersion,
    audit,
    opts,
    workDir
  };
}

/* ----- canTransform ----- */

describe('canTransform', () => {
  it('returns true for SCORM 1.2 with multiple top-level <h1>s', () => {
    const ctx = makeContext({
      files: [
        { path: 'lesson.html', content: makeLessonHtmlWithThreeH1s() },
        { path: 'imsmanifest.xml', content: SCORM12_MANIFEST }
      ]
    });
    expect(transformer.canTransform(ctx)).toBe(true);
  });

  it('returns true on file size > 50KB threshold', () => {
    const big = `<html><body><h1>x</h1>${'p'.repeat(60 * 1024)}</body></html>`;
    const ctx = makeContext({
      files: [
        { path: 'big.html', content: big },
        { path: 'imsmanifest.xml', content: SCORM12_MANIFEST }
      ]
    });
    expect(transformer.canTransform(ctx)).toBe(true);
  });

  it('returns true with explicit data-prism-split marker', () => {
    const html = `<!DOCTYPE html><html><body><h1>One</h1><p>x</p><hr role="separator" data-prism-split><p>y</p></body></html>`;
    const ctx = makeContext({
      files: [
        { path: 'lesson.html', content: html },
        { path: 'imsmanifest.xml', content: SCORM12_MANIFEST }
      ]
    });
    expect(transformer.canTransform(ctx)).toBe(true);
  });

  it('returns true with prism-split HTML comment marker', () => {
    const html = `<!DOCTYPE html><html><body><p>before</p><!-- prism-split --><p>after</p></body></html>`;
    const ctx = makeContext({
      files: [
        { path: 'lesson.html', content: html },
        { path: 'imsmanifest.xml', content: SCORM12_MANIFEST }
      ]
    });
    expect(transformer.canTransform(ctx)).toBe(true);
  });

  it('returns true on a 2.4.1 audit finding for the file', () => {
    const html = `<!DOCTYPE html><html><body><p>just one paragraph</p></body></html>`;
    const ctx = makeContext({
      files: [
        { path: 'lesson.html', content: html },
        { path: 'imsmanifest.xml', content: SCORM12_MANIFEST }
      ],
      audit: { violations: [{ file: 'lesson.html', criterion: '2.4.1' }] }
    });
    expect(transformer.canTransform(ctx)).toBe(true);
  });

  it('declines AICC packages', () => {
    const ctx = makeContext({
      parserVersion: 'aicc',
      files: [{ path: 'lesson.html', content: makeLessonHtmlWithThreeH1s() }]
    });
    expect(transformer.canTransform(ctx)).toBe(false);
  });

  it('declines cmi5 packages', () => {
    const ctx = makeContext({
      parserVersion: 'cmi5',
      files: [{ path: 'lesson.html', content: makeLessonHtmlWithThreeH1s() }]
    });
    expect(transformer.canTransform(ctx)).toBe(false);
  });

  it('returns false when no qualifying file is found', () => {
    const html = `<!DOCTYPE html><html><body><h1>only one</h1><p>tiny</p></body></html>`;
    const ctx = makeContext({
      files: [
        { path: 'lesson.html', content: html },
        { path: 'imsmanifest.xml', content: SCORM12_MANIFEST }
      ]
    });
    expect(transformer.canTransform(ctx)).toBe(false);
  });
});

/* ----- apply: heuristic happy path ----- */

describe('apply — heuristic happy path', () => {
  it('produces 3 new files + 3 manifest resources from a 3-h1 page; original deleted', async () => {
    const workDir = makeWorkDir();
    const files = [
      { path: 'lesson.html', content: makeLessonHtmlWithThreeH1s() },
      { path: 'imsmanifest.xml', content: SCORM12_MANIFEST }
    ];
    writeWorkDir(workDir, files);
    const ctx = makeContext({ files, workDir });
    const { transform, patches, log } = await transformer.apply(ctx);

    expect(transform.family).toBe('page-split');
    expect(transform.scope.manifestEdited).toBe(true);
    expect(transform.requiresCheckpointApproval).toBe(true);
    expect(transform.status).toBe('pending-checkpoint');
    expect(transform.criteria).toEqual(['2.4.1', '3.3.x', '1.3.1']);

    // 3 create patches + 1 delete patch + 1 manifest edit patch = 5
    expect(patches).toHaveLength(5);

    const createPatches = patches.filter((p) => p.before === '' && p.after !== '');
    const deletePatches = patches.filter((p) => p.before !== '' && p.after === '');
    const editPatches = patches.filter((p) => p.before !== '' && p.after !== '');
    expect(createPatches).toHaveLength(3);
    expect(deletePatches).toHaveLength(1);
    expect(editPatches).toHaveLength(1);
    expect(deletePatches[0].file).toBe('lesson.html');
    expect(/imsmanifest\.xml$/.test(editPatches[0].file)).toBe(true);

    // Files on disk reflect the staged state.
    expect(fs.existsSync(path.join(workDir, 'lesson.html'))).toBe(false);
    expect(fs.existsSync(path.join(workDir, 'lesson-part-1.html'))).toBe(true);
    expect(fs.existsSync(path.join(workDir, 'lesson-part-2.html'))).toBe(true);
    expect(fs.existsSync(path.join(workDir, 'lesson-part-3.html'))).toBe(true);

    // The manifest now has 3 resources where it had 1.
    const newManifestXml = fs.readFileSync(path.join(workDir, 'imsmanifest.xml'), 'utf8');
    const reparsed = await parseManifest(newManifestXml);
    const result = validateManifest(reparsed);
    expect(result.valid).toBe(true);
    const resources = reparsed.ast.manifest.resources[0].resource;
    expect(resources).toHaveLength(3);
    const items = reparsed.ast.manifest.organizations[0].organization[0].item;
    expect(items).toHaveLength(3);

    // Title format is "<original> (Part N of K)".
    const titles = items.map((i) => Array.isArray(i.title) ? i.title[0] : i.title);
    expect(titles[0]).toBe('Lesson (Part 1 of 3)');
    expect(titles[2]).toBe('Lesson (Part 3 of 3)');

    expect(log.length).toBeGreaterThan(0);
  });

  it('every page-split patch has confidence "needs-review" in heuristic mode', async () => {
    const workDir = makeWorkDir();
    const files = [
      { path: 'lesson.html', content: makeLessonHtmlWithThreeH1s() },
      { path: 'imsmanifest.xml', content: SCORM12_MANIFEST }
    ];
    writeWorkDir(workDir, files);
    const ctx = makeContext({ files, workDir });
    const { patches } = await transformer.apply(ctx);
    for (const p of patches) {
      expect(p.confidence).toBe('needs-review');
      expect(p.tier).toBe('full');
      expect(p.triage).toBe('author rework');
      expect(p.fixer).toBe('page-split');
      expect(p.provenance.source).toBe('rule-based');
    }
  });
});

/* ----- explicit marker mode ----- */

describe('apply — explicit markers take precedence over <h1>', () => {
  const html = `<!DOCTYPE html>
<html><head><title>X</title></head>
<body>
<h1>Topic A</h1>
<p>before marker, with one h1</p>
<hr role="separator" data-prism-split>
<p>after marker</p>
<h1>Topic B</h1>
<p>more content</p>
</body>
</html>
`;
  it('uses 1 HR marker as boundary => 2 splits (not 2 from <h1> heuristic)', async () => {
    const workDir = makeWorkDir();
    const files = [
      { path: 'lesson.html', content: html },
      { path: 'imsmanifest.xml', content: SCORM12_MANIFEST }
    ];
    writeWorkDir(workDir, files);
    const ctx = makeContext({ files, workDir });
    const { patches } = await transformer.apply(ctx);
    const createPatches = patches.filter((p) => p.before === '' && p.after !== '');
    // 1 HR marker => 2 splits => 2 create-from-empty patches (also 1 delete + 1 manifest edit).
    // The h1 heuristic would have produced 2 splits as well in this fixture,
    // but the marker mode wins. We additionally check that the marker is NOT
    // present in either split (separator mode drops it).
    expect(createPatches.length).toBe(2);
    for (const p of createPatches) {
      expect(p.after).not.toContain('data-prism-split');
    }
  });
});

/* The HR-marker assertion above documents real semantics: chooseHeuristicSplitPoints returns marker NODES; with 1 HR, buildSplitBodies produces 2 groups -> 2 new files. We re-assert explicitly: */
describe('explicit marker — 2 markers produce 3 split files', () => {
  const html = `<!DOCTYPE html>
<html><head><title>X</title></head>
<body>
<p>intro</p>
<hr role="separator" data-prism-split>
<p>middle</p>
<hr role="separator" data-prism-split>
<p>final</p>
</body>
</html>
`;
  it('splits at every HR marker', async () => {
    const workDir = makeWorkDir();
    const files = [
      { path: 'lesson.html', content: html },
      { path: 'imsmanifest.xml', content: SCORM12_MANIFEST }
    ];
    writeWorkDir(workDir, files);
    const ctx = makeContext({ files, workDir });
    const { patches } = await transformer.apply(ctx);
    const createPatches = patches.filter((p) => p.before === '' && p.after !== '');
    expect(createPatches.length).toBe(3);
  });
});

/* ----- round-trip via revert ----- */

describe('apply -> revert round-trip', () => {
  it('revert restores the original file and manifest byte-equal', async () => {
    const workDir = makeWorkDir();
    const originalLesson = makeLessonHtmlWithThreeH1s();
    const originalManifest = SCORM12_MANIFEST;
    const files = [
      { path: 'lesson.html', content: originalLesson },
      { path: 'imsmanifest.xml', content: originalManifest }
    ];
    writeWorkDir(workDir, files);

    const ctx = makeContext({ files, workDir });
    const { transform, patches } = await transformer.apply(ctx);

    // Stamp transform id + transformId on patches (the orchestrator does
    // this after manifest.addPatch / addTransform; we simulate that).
    const transformId = 'transform-0001';
    transform.id = transformId;
    const linkedPatches = patches.map((p, i) => ({
      ...p,
      id: `patch-${String(i + 1).padStart(4, '0')}`,
      transformId
    }));

    // Revert.
    await transformer.revert({ workDir, patches: linkedPatches }, transform);

    expect(fs.existsSync(path.join(workDir, 'lesson.html'))).toBe(true);
    expect(fs.existsSync(path.join(workDir, 'lesson-part-1.html'))).toBe(false);
    expect(fs.existsSync(path.join(workDir, 'lesson-part-2.html'))).toBe(false);
    expect(fs.existsSync(path.join(workDir, 'lesson-part-3.html'))).toBe(false);
    expect(fs.readFileSync(path.join(workDir, 'lesson.html'), 'utf8')).toBe(originalLesson);
    expect(fs.readFileSync(path.join(workDir, 'imsmanifest.xml'), 'utf8')).toBe(originalManifest);
  });
});

/* ----- manifest XML well-formedness post-apply ----- */

describe('manifest XML well-formedness', () => {
  it('post-apply manifest validates against the editor', async () => {
    const workDir = makeWorkDir();
    const files = [
      { path: 'lesson.html', content: makeLessonHtmlWithThreeH1s() },
      { path: 'imsmanifest.xml', content: SCORM12_MANIFEST }
    ];
    writeWorkDir(workDir, files);
    await transformer.apply(makeContext({ files, workDir }));
    const newXml = fs.readFileSync(path.join(workDir, 'imsmanifest.xml'), 'utf8');
    const parsed = await parseManifest(newXml);
    expect(validateManifest(parsed).valid).toBe(true);
  });
});

/* ----- SCO sequence integrity ----- */

describe('SCO sequence integrity', () => {
  it('inserts split items in the original item position; unrelated items unchanged', async () => {
    const multiManifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="ex.multi" version="1.0"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="ORG-1"><organization identifier="ORG-1">
    <title>Multi</title>
    <item identifier="ITEM-INTRO" identifierref="RES-INTRO"><title>Intro</title></item>
    <item identifier="ITEM-LESSON" identifierref="RES-LESSON"><title>Lesson</title></item>
    <item identifier="ITEM-OUTRO" identifierref="RES-OUTRO"><title>Outro</title></item>
  </organization></organizations>
  <resources>
    <resource identifier="RES-INTRO" type="webcontent" adlcp:scormtype="sco" href="intro.html"><file href="intro.html"/></resource>
    <resource identifier="RES-LESSON" type="webcontent" adlcp:scormtype="sco" href="lesson.html"><file href="lesson.html"/></resource>
    <resource identifier="RES-OUTRO" type="webcontent" adlcp:scormtype="sco" href="outro.html"><file href="outro.html"/></resource>
  </resources>
</manifest>
`;
    const workDir = makeWorkDir();
    const files = [
      { path: 'intro.html', content: '<html><body><p>intro</p></body></html>' },
      { path: 'lesson.html', content: makeLessonHtmlWithThreeH1s() },
      { path: 'outro.html', content: '<html><body><p>outro</p></body></html>' },
      { path: 'imsmanifest.xml', content: multiManifest }
    ];
    writeWorkDir(workDir, files);
    await transformer.apply(makeContext({ files, workDir }));

    const newXml = fs.readFileSync(path.join(workDir, 'imsmanifest.xml'), 'utf8');
    const parsed = await parseManifest(newXml);
    const items = parsed.ast.manifest.organizations[0].organization[0].item;
    const ids = items.map((i) => i.$.identifierref);
    expect(ids[0]).toBe('RES-INTRO');
    expect(ids[ids.length - 1]).toBe('RES-OUTRO');
    expect(ids.length).toBe(5); // intro + 3 splits + outro
  });
});

/* ----- decline rules ----- */

describe('decline rules', () => {
  it('declines when the package is AICC', () => {
    const ctx = makeContext({
      parserVersion: 'aicc',
      files: [{ path: 'page.html', content: makeLessonHtmlWithThreeH1s() }]
    });
    expect(transformer.canTransform(ctx)).toBe(false);
  });

  it('declines when the package is cmi5', () => {
    const ctx = makeContext({
      parserVersion: 'cmi5',
      files: [{ path: 'page.html', content: makeLessonHtmlWithThreeH1s() }]
    });
    expect(transformer.canTransform(ctx)).toBe(false);
  });

  it('declines on apply when a <form> spans split boundaries', async () => {
    const html = `<!DOCTYPE html><html><body>
<form action="/submit">
  <h1>Section A</h1>
  <input name="a">
  <hr role="separator" data-prism-split>
  <h1>Section B</h1>
  <input name="b">
  <button type="submit">Submit</button>
</form>
</body></html>`;
    const workDir = makeWorkDir();
    const files = [
      { path: 'lesson.html', content: html },
      { path: 'imsmanifest.xml', content: SCORM12_MANIFEST }
    ];
    writeWorkDir(workDir, files);
    await expect(transformer.apply(makeContext({ files, workDir }))).rejects.toThrow(/form/);
  });

  it('declines on apply when an inline script references an id in a different split', async () => {
    const html = `<!DOCTYPE html><html><body>
<h1>One</h1>
<p id="far-target">target</p>
<h1>Two</h1>
<script>document.getElementById('far-target').innerText = 'edited';</script>
</body></html>`;
    const workDir = makeWorkDir();
    const files = [
      { path: 'lesson.html', content: html },
      { path: 'imsmanifest.xml', content: SCORM12_MANIFEST }
    ];
    writeWorkDir(workDir, files);
    await expect(transformer.apply(makeContext({ files, workDir }))).rejects.toThrow(/script references id/);
  });

  it('declines on apply when the organization is non-standard (no <item> children)', async () => {
    const noItemsManifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="ex.broken" version="1.0"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="ORG-1"><organization identifier="ORG-1"><title>Empty</title></organization></organizations>
  <resources>
    <resource identifier="RES-LESSON" type="webcontent" adlcp:scormtype="sco" href="lesson.html"><file href="lesson.html"/></resource>
  </resources>
</manifest>
`;
    const workDir = makeWorkDir();
    const files = [
      { path: 'lesson.html', content: makeLessonHtmlWithThreeH1s() },
      { path: 'imsmanifest.xml', content: noItemsManifest }
    ];
    writeWorkDir(workDir, files);
    await expect(transformer.apply(makeContext({ files, workDir }))).rejects.toThrow(/organization|item/i);
  });
});

/* ----- determinism ----- */

describe('determinism', () => {
  it('two runs on the same input produce byte-identical splits and manifest edits', async () => {
    async function run() {
      const workDir = makeWorkDir();
      const files = [
        { path: 'lesson.html', content: makeLessonHtmlWithThreeH1s() },
        { path: 'imsmanifest.xml', content: SCORM12_MANIFEST }
      ];
      writeWorkDir(workDir, files);
      await transformer.apply(makeContext({ files, workDir }));
      return {
        p1: fs.readFileSync(path.join(workDir, 'lesson-part-1.html'), 'utf8'),
        p2: fs.readFileSync(path.join(workDir, 'lesson-part-2.html'), 'utf8'),
        p3: fs.readFileSync(path.join(workDir, 'lesson-part-3.html'), 'utf8'),
        m: fs.readFileSync(path.join(workDir, 'imsmanifest.xml'), 'utf8')
      };
    }
    const a = await run();
    const b = await run();
    expect(a).toEqual(b);
  });

  it('resource identifiers are stable across runs', async () => {
    const workDir1 = makeWorkDir();
    const workDir2 = makeWorkDir();
    const files = [
      { path: 'lesson.html', content: makeLessonHtmlWithThreeH1s() },
      { path: 'imsmanifest.xml', content: SCORM12_MANIFEST }
    ];
    writeWorkDir(workDir1, files);
    writeWorkDir(workDir2, files);
    await transformer.apply(makeContext({ files, workDir: workDir1 }));
    await transformer.apply(makeContext({ files, workDir: workDir2 }));
    const m1 = await parseManifest(fs.readFileSync(path.join(workDir1, 'imsmanifest.xml'), 'utf8'));
    const m2 = await parseManifest(fs.readFileSync(path.join(workDir2, 'imsmanifest.xml'), 'utf8'));
    const ids1 = m1.ast.manifest.resources[0].resource.map((r) => r.$.identifier);
    const ids2 = m2.ast.manifest.resources[0].resource.map((r) => r.$.identifier);
    expect(ids1).toEqual(ids2);
  });
});

/* ----- transformer interface contract ----- */

describe('Transformer interface contract', () => {
  it('exposes the duck-typed Transformer surface from PRD § Transformer interface', () => {
    expect(transformer.id).toBe('page-split');
    expect(transformer.family).toBe('page-split');
    expect(transformer.supported).toEqual(['scorm12', 'scorm2004']);
    expect(transformer.tier).toBe('full');
    expect(transformer.triage).toBe('author rework');
    expect(transformer.criteria).toEqual(['2.4.1', '3.3.x', '1.3.1']);
    expect(typeof transformer.canTransform).toBe('function');
    expect(typeof transformer.apply).toBe('function');
    expect(typeof transformer.revert).toBe('function');
  });

  it('falls back to rule-based provenance when v4.1 LLM provider is absent', async () => {
    const workDir = makeWorkDir();
    const files = [
      { path: 'lesson.html', content: makeLessonHtmlWithThreeH1s() },
      { path: 'imsmanifest.xml', content: SCORM12_MANIFEST }
    ];
    writeWorkDir(workDir, files);
    const ctx = makeContext({ files, workDir, opts: { allowLLMSplit: true } });
    const { patches } = await transformer.apply(ctx);
    for (const p of patches) {
      expect(p.provenance.source).toBe('rule-based');
    }
  });
});
