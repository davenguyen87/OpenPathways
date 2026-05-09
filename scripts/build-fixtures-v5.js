/**
 * Build v5 full-tier rebuild .zip fixtures for the chunk-09 integration tests.
 *
 * Usage: node scripts/build-fixtures-v5.js
 *
 * Produces (or regenerates) four fixtures + sidecars in test/fixtures/:
 *   rebuild-landmark-needed.zip + .expected.json
 *   rebuild-tabs-divsoup.zip + .expected.json
 *   rebuild-overflowing-page.zip + .expected.json
 *   rebuild-full-mixed.zip + .expected.json
 *
 * Fixtures are SCORM 1.2 packages built with yazl's deterministic entry-order
 * (mtime forced to epoch) so the resulting zip bytes are reproducible across
 * machines. Mirrors scripts/build-fixtures.js which builds v4's fixtures.
 *
 * Re-run this script whenever the fixture HTML / manifest source changes here.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const yazl = require('yazl');

const FIXTURES_DIR = path.resolve(__dirname, '../test/fixtures');

// ─── Shared SCORM 1.2 manifest template ────────────────────────────────────

/**
 * Build a SCORM 1.2 imsmanifest.xml from a flat list of resources. Every
 * resource produces one <item> in the default organization, in input order.
 *
 * @param {Array<{id:string, href:string, title:string}>} resources
 * @returns {string}
 */
function scormManifest(resources) {
  const itemElems = resources
    .map(
      (r, i) =>
        `      <item identifier="item${i + 1}" identifierref="${r.id}">\n` +
        `        <title>${r.title}</title>\n      </item>`
    )
    .join('\n');
  const resourceElems = resources
    .map(
      (r) =>
        `    <resource identifier="${r.id}" type="webcontent" href="${r.href}" adlcp:scormtype="sco">\n` +
        `      <file href="${r.href}"/>\n    </resource>`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="com.prism.fixture.v5" version="1.0"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="org1">
    <organization identifier="org1">
      <title>Prism v5 Test Fixture</title>
${itemElems}
    </organization>
  </organizations>
  <resources>
${resourceElems}
  </resources>
</manifest>
`;
}

// ─── Deterministic zip builder ─────────────────────────────────────────────

function buildZip(destPath, entries) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const ws = fs.createWriteStream(destPath);
    let settled = false;
    const fail = (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };
    ws.on('finish', () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    ws.on('error', fail);
    zip.outputStream.on('error', fail);
    zip.outputStream.pipe(ws);

    for (const entry of entries) {
      const buf = Buffer.isBuffer(entry.content)
        ? entry.content
        : Buffer.from(entry.content, 'utf8');
      zip.addBuffer(buf, entry.name, { mtime: new Date(0) });
    }
    zip.end();
  });
}

function writeJson(destPath, obj) {
  fs.writeFileSync(destPath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

// ─── Fixture 1: rebuild-landmark-needed.zip ────────────────────────────────
//
// Targets landmark-insertion + landmark-labeling.
//
//   page1.html — <div class="main"> wrapping body content (no <main>) → main
//   page2.html — <div class="main"> wrapping body content (no <main>) → main
//   page3.html — <div class="main"> wrapping body content (no <main>) → main
//   page4.html — <div role="main"> on a div (role-based promotion to <main>)
//   page5.html — two <nav> elements; one labeled, one not → labeling fixes
//                the unlabeled nav

const LANDMARK_PAGE1 = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Landmark Page 1</title></head>
<body>
<div class="main">
<h1>Module 1</h1>
<p>Content for module 1.</p>
</div>
</body></html>
`;

const LANDMARK_PAGE2 = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Landmark Page 2</title></head>
<body>
<div class="main">
<h1>Module 2</h1>
<p>Content for module 2.</p>
</div>
</body></html>
`;

const LANDMARK_PAGE3 = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Landmark Page 3</title></head>
<body>
<div class="main">
<h1>Module 3</h1>
<p>Content for module 3.</p>
</div>
</body></html>
`;

const LANDMARK_PAGE4_ROLE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Landmark Page 4</title></head>
<body>
<div role="main">
<h1>Module 4</h1>
<p>Content for module 4.</p>
</div>
</body></html>
`;

// Two <nav> elements, one with aria-label, one without → labeling fires.
const LANDMARK_PAGE5_NAV = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Landmark Page 5</title></head>
<body>
<nav aria-label="Primary">
<ul><li><a href="page1.html">Page 1</a></li></ul>
</nav>
<h1>Page 5 with two navs</h1>
<p>Body content.</p>
<nav>
<ul><li><a href="page2.html">Page 2</a></li></ul>
</nav>
</body></html>
`;

// ─── Fixture 2: rebuild-tabs-divsoup.zip ───────────────────────────────────
//
// Targets widget-replacement-tabs.
//
//   tab-page-a.html / tab-page-b.html — clean div-soup tabsets (3 tabs each).
//                                       Should be claimed and replaced.
//   tab-page-form.html  — tabset contains a <form> → decline form-in-source.
//   tab-page-many.html  — 13 tabs > MAX_TABS=9 → decline too-many-panels.
//
// Tabs README rule 4 limits to 9 panels; the chunk-09 prompt asks for "> 12
// tabs (must decline)" — 13 is over both thresholds.
//
// Each tabset uses class="tab-container" + class="panel" so it matches the
// transformer's signature exactly. The page also includes an explicit
// 4.1.2 violation on the wrapper so the audit-finding gate passes.

function buildTabsetHtml(tabCount, idPrefix) {
  const tabs = [];
  const panels = [];
  for (let i = 1; i <= tabCount; i++) {
    tabs.push(
      `      <li><a href="#${idPrefix}-${i}" data-target="${idPrefix}-${i}">Tab ${i}</a></li>`
    );
    panels.push(
      `    <div class="panel" id="${idPrefix}-${i}"><h3>Tab ${i} content</h3><p>Detail ${i}.</p></div>`
    );
  }
  return (
    `  <div class="tab-container">\n` +
    `    <ul class="tabs">\n` +
    tabs.join('\n') +
    `\n    </ul>\n` +
    panels.join('\n') +
    `\n  </div>\n`
  );
}

const TAB_PAGE_A = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Tabs Page A</title></head>
<body>
<h1>Tabs Page A</h1>
<p>Three-tab page A.</p>
${buildTabsetHtml(3, 'a')}
</body></html>
`;

const TAB_PAGE_B = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Tabs Page B</title></head>
<body>
<h1>Tabs Page B</h1>
<p>Three-tab page B.</p>
${buildTabsetHtml(3, 'b')}
</body></html>
`;

// Form inside the tabset → decline.
const TAB_PAGE_FORM = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Tabs Page (Form)</title></head>
<body>
<h1>Tabs Page with Form</h1>
<div class="tab-container">
  <ul class="tabs">
    <li><a href="#f-1" data-target="f-1">Login</a></li>
    <li><a href="#f-2" data-target="f-2">Register</a></li>
  </ul>
  <div class="panel" id="f-1">
    <form action="/login" method="post">
      <label>Username <input type="text" name="username"></label>
      <button type="submit">Sign in</button>
    </form>
  </div>
  <div class="panel" id="f-2">
    <p>Sign up details go here.</p>
  </div>
</div>
</body></html>
`;

// 13 tabs > MAX_TABS=9 → decline.
const TAB_PAGE_MANY = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Tabs Page (Many)</title></head>
<body>
<h1>Tabs Page with Many Tabs</h1>
${buildTabsetHtml(13, 'm')}
</body></html>
`;

// ─── Fixture 3: rebuild-overflowing-page.zip ───────────────────────────────
//
// Targets page-split.
//
//   sco-large.html — > 50 KB, four top-level <h1>s → heuristic h1-anchor split.
//   sco-marker.html — explicit <!-- prism-split --> markers → separator split.
//   sco-small.html — has a 2.4.1 finding but is well under the 50KB threshold
//                    AND has only one top-level <h1>; page-split.qualifies()
//                    returns true (audit-driven), but apply() will throw
//                    "no split boundaries detected" → orchestrator's apply
//                    error path turns it into a deferred finding.
//                    Documented in expected.json.

// Build a > 50 KB page with four h1 boundaries. Each section has padding to
// push the page over the threshold.
function buildLargeSco() {
  const padding = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(250);
  const sections = [];
  for (let i = 1; i <= 4; i++) {
    sections.push(
      `<h1>Section ${i}</h1>\n<p>Section ${i} introduction.</p>\n<p>${padding}</p>`
    );
  }
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Large SCO</title></head>
<body>
${sections.join('\n')}
</body></html>
`;
}

const SCO_LARGE = buildLargeSco();

const SCO_MARKER = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Marker SCO</title></head>
<body>
<h1>Module Title</h1>
<p>Introduction to the module.</p>
<!-- prism-split -->
<h2>Part Two</h2>
<p>The second section.</p>
<!-- prism-split -->
<h2>Part Three</h2>
<p>The third section.</p>
</body></html>
`;

const SCO_SMALL = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Small SCO</title></head>
<body>
<h1>Tiny Page</h1>
<p>Has a 2.4.1 finding (in test fixture only) but no boundaries to split on.</p>
</body></html>
`;

// ─── Fixture 4: rebuild-full-mixed.zip ─────────────────────────────────────
//
// End-to-end fixture that exercises the orchestrator's full dispatch:
//
//   page-decorative.html — 2 decorative imgs (v4 add-alt-decorative).
//   page-form.html       — unambiguous label/input pair (v4 associate-form-label).
//   page-landmark.html   — <div class="main-content"> → landmark-insertion.
//   page-tabs.html       — 3-tab div-soup tabset → widget-replacement-tabs.
//   sco-overflow.html    — > 50 KB with 4 h1s → page-split.
//   page-unclaimed.html  — 1.4.4 finding (no v4/v5 fixer claims) → deferred.

const FULL_DECORATIVE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Mixed Decorative</title></head>
<body>
<h1>Decorative</h1>
<p>Some content.</p>
<img src="spacer.gif">
<p>More content.</p>
<img src="blank.gif">
</body></html>
`;

const FULL_FORM = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Mixed Form</title></head>
<body>
<h1>Form</h1>
<form>
  <div>
    <label>Email Address</label>
    <input type="email" name="email">
  </div>
</form>
</body></html>
`;

const FULL_LANDMARK = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Mixed Landmark</title></head>
<body>
<div class="main-content">
<h1>Module 7</h1>
<p>Body content.</p>
</div>
</body></html>
`;

const FULL_TABS = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Mixed Tabs</title></head>
<body>
<h1>Tabs</h1>
<p>Three-tab page.</p>
${buildTabsetHtml(3, 'mx')}
</body></html>
`;

function buildMixedOverflowSco() {
  const padding = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(260);
  const sections = [];
  for (let i = 1; i <= 4; i++) {
    sections.push(
      `<h1>Chapter ${i}</h1>\n<p>Chapter ${i} intro.</p>\n<p>${padding}</p>`
    );
  }
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Overflow SCO</title></head>
<body>
${sections.join('\n')}
</body></html>
`;
}

const FULL_OVERFLOW = buildMixedOverflowSco();

const FULL_UNCLAIMED = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Mixed Unclaimed</title></head>
<body>
<h1>Unclaimed</h1>
<p style="font-size: 9px;">This text uses an absolute font size — 1.4.4 violation.</p>
</body></html>
`;

// ─── Write all fixtures ────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });

  // ── Fixture 1: rebuild-landmark-needed.zip ───────────────────────────────
  await buildZip(path.join(FIXTURES_DIR, 'rebuild-landmark-needed.zip'), [
    {
      name: 'imsmanifest.xml',
      content: scormManifest([
        { id: 'res1', href: 'page1.html', title: 'Page 1' },
        { id: 'res2', href: 'page2.html', title: 'Page 2' },
        { id: 'res3', href: 'page3.html', title: 'Page 3' },
        { id: 'res4', href: 'page4.html', title: 'Page 4' },
        { id: 'res5', href: 'page5.html', title: 'Page 5' }
      ])
    },
    { name: 'page1.html', content: LANDMARK_PAGE1 },
    { name: 'page2.html', content: LANDMARK_PAGE2 },
    { name: 'page3.html', content: LANDMARK_PAGE3 },
    { name: 'page4.html', content: LANDMARK_PAGE4_ROLE },
    { name: 'page5.html', content: LANDMARK_PAGE5_NAV }
  ]);
  writeJson(path.join(FIXTURES_DIR, 'rebuild-landmark-needed.expected.json'), {
    _description:
      'SCORM 1.2 with five HTML pages: three div.main wrappers, one role=main div, ' +
      'and one page with two <nav> (one labeled, one not). Targets landmark-insertion ' +
      '(promotes div.main and role=main divs to <main>) and landmark-labeling ' +
      '(adds aria-label to the unlabeled <nav>).',
    packageName: 'rebuild-landmark-needed.zip',
    violations: { expectedCriteria: ['1.3.1', '4.1.2'] },
    rebuild: {
      mode: 'full',
      expectedTransformers: ['landmark-insertion', 'landmark-labeling'],
      expectedTransformFamilies: ['landmark'],
      manifestEdited: false,
      expectedResolved: { gt: 0 },
      expectedIntroduced: 0
    },
    decline: {
      reasons: []
    }
  });
  console.log('  wrote rebuild-landmark-needed.zip');

  // ── Fixture 2: rebuild-tabs-divsoup.zip ──────────────────────────────────
  await buildZip(path.join(FIXTURES_DIR, 'rebuild-tabs-divsoup.zip'), [
    {
      name: 'imsmanifest.xml',
      content: scormManifest([
        { id: 'res1', href: 'tab-page-a.html', title: 'Tabs A' },
        { id: 'res2', href: 'tab-page-b.html', title: 'Tabs B' },
        { id: 'res3', href: 'tab-page-form.html', title: 'Tabs Form' },
        { id: 'res4', href: 'tab-page-many.html', title: 'Tabs Many' }
      ])
    },
    { name: 'tab-page-a.html', content: TAB_PAGE_A },
    { name: 'tab-page-b.html', content: TAB_PAGE_B },
    { name: 'tab-page-form.html', content: TAB_PAGE_FORM },
    { name: 'tab-page-many.html', content: TAB_PAGE_MANY }
  ]);
  writeJson(path.join(FIXTURES_DIR, 'rebuild-tabs-divsoup.expected.json'), {
    _description:
      'SCORM 1.2 with four HTML pages exercising widget-replacement-tabs: ' +
      'two clean 3-tab pages (accept), one 2-tab page nesting a <form> (decline), ' +
      'and one 13-tab page (decline as too-many-panels).',
    packageName: 'rebuild-tabs-divsoup.zip',
    violations: { expectedCriteria: ['1.3.1', '4.1.2'] },
    rebuild: {
      mode: 'full',
      expectedTransformers: ['widget-replacement-tabs'],
      expectedTransformFamilies: ['widget'],
      manifestEdited: false,
      expectedResolved: { gt: 0 },
      expectedIntroduced: 0
    },
    decline: {
      reasons: ['form-in-source', 'too-many-panels']
    }
  });
  console.log('  wrote rebuild-tabs-divsoup.zip');

  // ── Fixture 3: rebuild-overflowing-page.zip ──────────────────────────────
  await buildZip(path.join(FIXTURES_DIR, 'rebuild-overflowing-page.zip'), [
    {
      name: 'imsmanifest.xml',
      content: scormManifest([
        { id: 'res1', href: 'sco-large.html', title: 'Large SCO' },
        { id: 'res2', href: 'sco-marker.html', title: 'Marker SCO' },
        { id: 'res3', href: 'sco-small.html', title: 'Small SCO' }
      ])
    },
    { name: 'sco-large.html', content: SCO_LARGE },
    { name: 'sco-marker.html', content: SCO_MARKER },
    { name: 'sco-small.html', content: SCO_SMALL }
  ]);
  writeJson(path.join(FIXTURES_DIR, 'rebuild-overflowing-page.expected.json'), {
    _description:
      'SCORM 1.2 with three SCOs targeting page-split: a > 50 KB SCO with four ' +
      '<h1> boundaries (heuristic h1-anchor split), an SCO with explicit ' +
      '<!-- prism-split --> markers (separator-mode split), and a small SCO that ' +
      'qualifies on a 2.4.1 finding but cannot be split (no boundaries) — ' +
      'orchestrator deferment path.',
    packageName: 'rebuild-overflowing-page.zip',
    violations: { expectedCriteria: ['2.4.1'] },
    rebuild: {
      mode: 'full',
      expectedTransformers: ['page-split'],
      expectedTransformFamilies: ['page-split'],
      manifestEdited: true,
      expectedResolved: { gt: 0 },
      expectedIntroduced: 0
    },
    notes: [
      'page-split runs once per orchestrator pass; only the first qualifying SCO is ' +
      'split. The integration test asserts at least one transform of family page-split ' +
      'lands. The marker-mode SCO and small SCO may be picked up across successive ' +
      'orchestrator passes once chunk-05+ implements iteration; v5.0 splits one SCO.'
    ]
  });
  console.log('  wrote rebuild-overflowing-page.zip');

  // ── Fixture 4: rebuild-full-mixed.zip ────────────────────────────────────
  await buildZip(path.join(FIXTURES_DIR, 'rebuild-full-mixed.zip'), [
    {
      name: 'imsmanifest.xml',
      content: scormManifest([
        { id: 'res1', href: 'page-decorative.html', title: 'Decorative' },
        { id: 'res2', href: 'page-form.html', title: 'Form' },
        { id: 'res3', href: 'page-landmark.html', title: 'Landmark' },
        { id: 'res4', href: 'page-tabs.html', title: 'Tabs' },
        { id: 'res5', href: 'sco-overflow.html', title: 'Overflow SCO' },
        { id: 'res6', href: 'page-unclaimed.html', title: 'Unclaimed' }
      ])
    },
    { name: 'page-decorative.html', content: FULL_DECORATIVE },
    { name: 'page-form.html', content: FULL_FORM },
    { name: 'page-landmark.html', content: FULL_LANDMARK },
    { name: 'page-tabs.html', content: FULL_TABS },
    { name: 'sco-overflow.html', content: FULL_OVERFLOW },
    { name: 'page-unclaimed.html', content: FULL_UNCLAIMED },
    { name: 'spacer.gif', content: Buffer.alloc(4, 0) },
    { name: 'blank.gif', content: Buffer.alloc(4, 0) }
  ]);
  writeJson(path.join(FIXTURES_DIR, 'rebuild-full-mixed.expected.json'), {
    _description:
      'End-to-end fixture exercising the orchestrator full dispatch: v4 fixers ' +
      '(add-alt-decorative + associate-form-label), v5 transformers (landmark-insertion, ' +
      'widget-replacement-tabs, page-split), and a deferred 1.4.4 finding.',
    packageName: 'rebuild-full-mixed.zip',
    violations: { expectedCriteria: ['1.1.1', '1.3.1', '2.4.1', '3.3.2', '4.1.2'] },
    rebuild: {
      mode: 'full',
      expectedFixers: ['add-alt-decorative', 'associate-form-label'],
      expectedTransformers: [
        'landmark-insertion',
        'widget-replacement-tabs',
        'page-split'
      ],
      expectedTransformFamilies: ['landmark', 'widget', 'page-split'],
      manifestEdited: true,
      expectedResolved: { gt: 0 },
      expectedIntroduced: 0
    },
    deferred: {
      expectedCriteria: ['1.4.4']
    }
  });
  console.log('  wrote rebuild-full-mixed.zip');

  // Print sizes for sanity.
  for (const name of [
    'rebuild-landmark-needed.zip',
    'rebuild-tabs-divsoup.zip',
    'rebuild-overflowing-page.zip',
    'rebuild-full-mixed.zip'
  ]) {
    const stat = fs.statSync(path.join(FIXTURES_DIR, name));
    console.log(`    ${name}: ${stat.size} bytes`);
  }
  console.log('Done. v5 fixtures + sidecars written to test/fixtures/');
}

main().catch((err) => {
  console.error('build-fixtures-v5 failed:', err);
  process.exitCode = 1;
});
