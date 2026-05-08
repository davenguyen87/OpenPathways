/**
 * Build rebuild-* zip fixtures for the v4 integration tests.
 *
 * Usage: node scripts/build-fixtures.js
 *
 * Produces (or regenerates) three fixtures in test/fixtures/:
 *   rebuild-decorative-imgs.zip
 *   rebuild-form-labels.zip
 *   rebuild-mixed-violations.zip
 *
 * All zips are built with yazl's deterministic entry-order so the bytes are
 * reproducible across machines. We intentionally strip extended zip metadata
 * (mtime is forced to the Unix epoch via yazl's mtime option) so the resulting
 * zip bytes are deterministic for content-equal inputs.
 *
 * Re-run this script whenever the fixture HTML source changes.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const yazl = require('yazl');

const FIXTURES_DIR = path.resolve(__dirname, '../test/fixtures');

// ─── Shared SCORM 1.2 manifest template ───────────────────────────────────

function scormManifest(resources) {
  const resourceElems = resources
    .map((r) => `    <resource identifier="${r.id}" type="webcontent" href="${r.href}" adlcp:scormtype="sco">\n      <file href="${r.href}"/>\n    </resource>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="com.prism.fixture" version="1.0"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="org1">
    <organization identifier="org1">
      <title>Prism Test Fixture</title>
      <item identifier="item1" identifierref="res1">
        <title>Page 1</title>
      </item>
    </organization>
  </organizations>
  <resources>
${resourceElems}
  </resources>
</manifest>
`;
}

// ─── Deterministic zip builder ─────────────────────────────────────────────

/**
 * Build a zip at `destPath` from an array of { name, content } entries
 * where content is a Buffer or string. Entries are written in declaration
 * order. mtime is forced to epoch so bytes are machine-independent.
 *
 * @param {string} destPath
 * @param {Array<{ name: string, content: Buffer|string }>} entries
 * @returns {Promise<void>}
 */
function buildZip(destPath, entries) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const ws = fs.createWriteStream(destPath);
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };
    ws.on('finish', () => { if (!settled) { settled = true; resolve(); } });
    ws.on('error', fail);
    zip.outputStream.on('error', fail);
    zip.outputStream.pipe(ws);

    for (const entry of entries) {
      const buf = Buffer.isBuffer(entry.content)
        ? entry.content
        : Buffer.from(entry.content, 'utf8');
      // mtime epoch makes the header bytes deterministic.
      zip.addBuffer(buf, entry.name, { mtime: new Date(0) });
    }
    zip.end();
  });
}

// ─── Fixture 1: rebuild-decorative-imgs ───────────────────────────────────
//
// One SCO HTML page with 4 decorative <img> elements (spacer.gif x2,
// divider.png, pixel.gif) — all without alt attributes and all matching the
// add-alt-decorative fixer's decorative-filename heuristic.  A second SCO
// HTML page has one <img role="presentation"> without alt, which the fixer
// also claims.
//
// Expected outcome: add-alt-decorative claims all 5 violations; all 5 resolved.

const DECORATIVE_PAGE1 = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Module 1 - Introduction</title>
</head>
<body>
  <h1>Introduction</h1>
  <p>Welcome to the module.</p>
  <img src="spacer.gif">
  <p>Section 1 content.</p>
  <img src="divider.png">
  <p>Section 2 content.</p>
  <img src="spacer.gif">
  <p>Section 3 content.</p>
  <img src="pixel.gif">
</body>
</html>
`;

const DECORATIVE_PAGE2 = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Module 1 - Summary</title>
</head>
<body>
  <h1>Summary</h1>
  <p>Review complete.</p>
  <img src="icon-small.gif" role="presentation">
</body>
</html>
`;

// ─── Fixture 2: rebuild-form-labels ───────────────────────────────────────
//
// Three form pages:
//   page1.html — one unambiguous label/input pair, missing for/id (fixable)
//   page2.html — one unambiguous label/input pair, missing for/id (fixable)
//   page3.html — two labels + two inputs in the same block (ambiguous; fixer declines)
//
// Expected outcome: associate-form-label claims 2 violations; 2 resolved.

const FORM_PAGE1 = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Form Page 1</title>
</head>
<body>
  <h1>Form 1</h1>
  <form>
    <div>
      <label>First Name</label>
      <input type="text" name="first_name">
    </div>
  </form>
</body>
</html>
`;

const FORM_PAGE2 = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Form Page 2</title>
</head>
<body>
  <h1>Form 2</h1>
  <form>
    <div>
      <label>Email Address</label>
      <input type="email" name="email">
    </div>
  </form>
</body>
</html>
`;

const FORM_PAGE3 = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Form Page 3</title>
</head>
<body>
  <h1>Form 3 - Ambiguous</h1>
  <form>
    <div>
      <label>First Name</label>
      <input type="text" name="first_name">
      <label>Last Name</label>
      <input type="text" name="last_name">
    </div>
  </form>
</body>
</html>
`;

// ─── Fixture 3: rebuild-mixed-violations ──────────────────────────────────
//
// Combines multiple violation types to exercise the orchestrator's full dispatch:
//
//   page-decorative.html  — 2 decorative images:
//       spacer.gif (fixable), blank.gif (fixable)
//   page-headings.html    — heading violations:
//       one fixable (page has no <h1>, first heading is <h2> → promoted to <h1>)
//       one declined (non-standard skip h1→h3 with multiple h2s; fixer declines)
//   page-video-with-vtt.html + intro.vtt — video with a sibling .vtt (wireable)
//   page-video-no-vtt.html              — video without a .vtt (deferred by fixer)
//   page-unclaimed.html                 — contains a violation that no v4 fixer claims
//                                         (simulated by giving it a criterion no fixer
//                                          registers for: 1.4.4 Resize text)
//
//   Target size: deliberately excluded — see rebuild-mixed-violations.expected.json
//   for the documented rationale (Option B from the chunk-09 spec).

const MIXED_DECORATIVE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Mixed Violations - Decorative</title>
</head>
<body>
  <h1>Page Heading</h1>
  <p>Some content here.</p>
  <img src="spacer.gif">
  <p>More content.</p>
  <img src="blank.gif">
</body>
</html>
`;

// This page has a standard heading-skip that normalize-heading-order can fix:
// page starts with <h2> (no <h1>) — single candidate, promoted to <h1>.
const MIXED_HEADINGS = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Mixed Violations - Headings</title>
</head>
<body>
  <h2>Section Title</h2>
  <p>Content under the only heading on this page.</p>
</body>
</html>
`;

// This page has a heading skip from h1→h3 with multiple h2 peers — the fixer
// declines this pattern as ambiguous (multiple peers at the first heading level).
const MIXED_HEADINGS_DECLINED = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Mixed Violations - Headings Declined</title>
</head>
<body>
  <h3>Subsection A</h3>
  <p>Content A.</p>
  <h3>Subsection B</h3>
  <p>Content B.</p>
</body>
</html>
`;

const MIXED_VIDEO_WITH_VTT = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Mixed Violations - Video with VTT</title>
</head>
<body>
  <h1>Video Lesson</h1>
  <video src="intro.mp4" controls>
    Your browser does not support video.
  </video>
</body>
</html>
`;

const MIXED_VIDEO_NO_VTT = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Mixed Violations - Video without VTT</title>
</head>
<body>
  <h1>Another Video</h1>
  <video src="lecture.mp4" controls>
    Your browser does not support video.
  </video>
</body>
</html>
`;

// This page has a violation for criterion 1.4.4 (Resize Text) which no v4
// fixer claims — exercises the "unclaimed → deferred" path in the orchestrator.
const MIXED_UNCLAIMED = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Mixed Violations - Unclaimed</title>
  <style>
    body { font-size: 10px; }
  </style>
</head>
<body>
  <h1>Text at fixed size</h1>
  <p style="font-size: 9px;">This text is too small and uses absolute units.</p>
</body>
</html>
`;

const INTRO_VTT = `WEBVTT

00:00:00.000 --> 00:00:05.000
Welcome to the course.

00:00:05.000 --> 00:00:10.000
Please review the material carefully.
`;

// ─── Write all fixtures ────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });

  // ── Fixture 1: rebuild-decorative-imgs.zip ─────────────────────────────
  await buildZip(path.join(FIXTURES_DIR, 'rebuild-decorative-imgs.zip'), [
    {
      name: 'imsmanifest.xml',
      content: scormManifest([
        { id: 'res1', href: 'page1.html' },
        { id: 'res2', href: 'page2.html' }
      ])
    },
    { name: 'page1.html', content: DECORATIVE_PAGE1 },
    { name: 'page2.html', content: DECORATIVE_PAGE2 },
    // Tiny 1×1 pixel placeholder images (binary content; real data not needed
    // because the HTML check operates on the HTML source, not the image data)
    { name: 'spacer.gif', content: Buffer.alloc(4, 0) },
    { name: 'divider.png', content: Buffer.alloc(4, 0) },
    { name: 'pixel.gif', content: Buffer.alloc(4, 0) },
    { name: 'icon-small.gif', content: Buffer.alloc(4, 0) }
  ]);
  console.log('  wrote rebuild-decorative-imgs.zip');

  // ── Fixture 2: rebuild-form-labels.zip ─────────────────────────────────
  await buildZip(path.join(FIXTURES_DIR, 'rebuild-form-labels.zip'), [
    {
      name: 'imsmanifest.xml',
      content: scormManifest([
        { id: 'res1', href: 'page1.html' },
        { id: 'res2', href: 'page2.html' },
        { id: 'res3', href: 'page3.html' }
      ])
    },
    { name: 'page1.html', content: FORM_PAGE1 },
    { name: 'page2.html', content: FORM_PAGE2 },
    { name: 'page3.html', content: FORM_PAGE3 }
  ]);
  console.log('  wrote rebuild-form-labels.zip');

  // ── Fixture 3: rebuild-mixed-violations.zip ────────────────────────────
  await buildZip(path.join(FIXTURES_DIR, 'rebuild-mixed-violations.zip'), [
    {
      name: 'imsmanifest.xml',
      content: scormManifest([
        { id: 'res1', href: 'page-decorative.html' },
        { id: 'res2', href: 'page-headings.html' },
        { id: 'res3', href: 'page-headings-declined.html' },
        { id: 'res4', href: 'page-video-with-vtt.html' },
        { id: 'res5', href: 'page-video-no-vtt.html' },
        { id: 'res6', href: 'page-unclaimed.html' }
      ])
    },
    { name: 'page-decorative.html', content: MIXED_DECORATIVE },
    { name: 'page-headings.html', content: MIXED_HEADINGS },
    { name: 'page-headings-declined.html', content: MIXED_HEADINGS_DECLINED },
    { name: 'page-video-with-vtt.html', content: MIXED_VIDEO_WITH_VTT },
    { name: 'page-video-no-vtt.html', content: MIXED_VIDEO_NO_VTT },
    { name: 'page-unclaimed.html', content: MIXED_UNCLAIMED },
    { name: 'intro.mp4', content: Buffer.alloc(4, 0) },
    { name: 'intro.vtt', content: INTRO_VTT },
    { name: 'lecture.mp4', content: Buffer.alloc(4, 0) },
    { name: 'spacer.gif', content: Buffer.alloc(4, 0) },
    { name: 'blank.gif', content: Buffer.alloc(4, 0) }
  ]);
  console.log('  wrote rebuild-mixed-violations.zip');

  console.log('Done. All fixtures written to test/fixtures/');
}

main().catch((err) => {
  console.error('build-fixtures failed:', err);
  process.exitCode = 1;
});
