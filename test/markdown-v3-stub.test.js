/**
 * Stub test for markdown-v3.js — verify section order and rendering with v3 enrichments.
 * Uses a synthetic scorecard with all v3 fields populated.
 */

import { describe, it, expect } from 'vitest';
import { renderMarkdownV3 } from '../src/reporter/markdown-v3.js';

const stubScorecard = {
  wcagVersion: '2.1',
  clientName: 'Acme Public Health Authority',
  engagementId: 'SL-2026-0418',
  passed: false,
  score: 67.2,
  totalCriteria: 50,
  passedCriteria: 42,
  failedCriteria: 8,
  totalViolations: 62,
  complete: true,
  incompleteReason: null,
  scannedAt: '2026-05-05T14:32:00Z',
  tool: 'open-pathways',
  version: '3.0.0',
  scos: [
    { id: 'sco1', title: 'HIPAA Refresher 2022', packageName: 'hipaa-refresher-2022.zip' },
    { id: 'sco2', title: 'Patient Privacy 101', packageName: 'patient-privacy-101.zip' },
    { id: 'sco3', title: 'Workplace Safety Quiz', packageName: 'workplace-safety-quiz.zip' },
  ],
  violations: [
    {
      criterion: '2.1.1',
      severity: 'critical',
      file: 'slide_07/interaction.html',
      line: 142,
      message: 'Drag-and-drop interaction traps keyboard focus',
      sco: { id: 'sco1', title: 'HIPAA Refresher 2022' },
      triage: 'author rework',
      effortMinutes: 45,
      section508: '501.1',
    },
    {
      criterion: '1.2.1',
      severity: 'critical',
      file: 'assets/intro.mp4',
      line: null,
      message: 'Embedded video has no caption track or transcript',
      sco: { id: 'sco2', title: 'Patient Privacy 101' },
      triage: 'content rework',
      effortMinutes: 360,
      section508: '501.5',
    },
    {
      criterion: '1.4.3',
      severity: 'serious',
      file: 'common/styles.css',
      line: 88,
      message: 'Body text contrast below 4.5:1',
      sco: { id: 'sco1', title: 'HIPAA Refresher 2022' },
      triage: 'auto-fix safe',
      effortMinutes: 5,
      section508: '502',
    },
    {
      criterion: '1.3.1',
      severity: 'serious',
      file: 'quiz_intro.html',
      line: 38,
      message: 'Form fields use placeholder as only label',
      sco: { id: 'sco3', title: 'Workplace Safety Quiz' },
      triage: 'auto-fix assisted',
      effortMinutes: 15,
      section508: '502',
    },
    {
      criterion: '1.1.1',
      severity: 'moderate',
      file: 'slides/workflow.png',
      line: null,
      message: 'Diagrammatic image with generic alt text',
      sco: { id: 'sco1', title: 'HIPAA Refresher 2022' },
      triage: 'auto-fix assisted',
      effortMinutes: 15,
      section508: '502',
    },
    {
      criterion: '3.1.1',
      severity: 'minor',
      file: 'index.html',
      line: 1,
      message: 'Missing lang attribute on root html element',
      sco: { id: 'sco1', title: 'HIPAA Refresher 2022' },
      triage: 'auto-fix safe',
      effortMinutes: 2,
      section508: '502',
    },
  ],
  criteriaResults: [
    {
      id: '1.1.1',
      name: 'Non-text content',
      level: 'A',
      wcagIntroduced: '2.0',
      url: 'https://www.w3.org/WAI/WCAG21/Understanding/non-text-content',
      evaluationMode: 'static',
      evaluated: true,
      passed: false,
      violationCount: 1,
    },
    {
      id: '1.2.1',
      name: 'Audio-only and video-only (prerecorded)',
      level: 'A',
      wcagIntroduced: '2.0',
      url: 'https://www.w3.org/WAI/WCAG21/Understanding/audio-only-and-video-only-prerecorded',
      evaluationMode: 'dynamic',
      evaluated: true,
      passed: false,
      violationCount: 1,
    },
    {
      id: '1.3.1',
      name: 'Info and relationships',
      level: 'A',
      wcagIntroduced: '2.0',
      url: 'https://www.w3.org/WAI/WCAG21/Understanding/info-and-relationships',
      evaluationMode: 'static',
      evaluated: true,
      passed: false,
      violationCount: 1,
    },
    {
      id: '1.4.3',
      name: 'Contrast (minimum)',
      level: 'AA',
      wcagIntroduced: '2.0',
      url: 'https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum',
      evaluationMode: 'static',
      evaluated: true,
      passed: false,
      violationCount: 1,
    },
    {
      id: '2.1.1',
      name: 'Keyboard',
      level: 'A',
      wcagIntroduced: '2.0',
      url: 'https://www.w3.org/WAI/WCAG21/Understanding/keyboard',
      evaluationMode: 'dynamic',
      evaluated: true,
      passed: false,
      violationCount: 1,
    },
    {
      id: '3.1.1',
      name: 'Language of page',
      level: 'A',
      wcagIntroduced: '2.0',
      url: 'https://www.w3.org/WAI/WCAG21/Understanding/language-of-page',
      evaluationMode: 'static',
      evaluated: true,
      passed: false,
      violationCount: 1,
    },
  ],
  // v3 enrichments
  triage: {
    rollup: [
      { tag: 'auto-fix safe', packageCount: 1, percentage: 33.3, effortHours: 0.17 },
      { tag: 'auto-fix assisted', packageCount: 2, percentage: 66.7, effortHours: 0.5 },
      { tag: 'author rework', packageCount: 1, percentage: 33.3, effortHours: 0.75 },
      { tag: 'content rework', packageCount: 1, percentage: 33.3, effortHours: 6.0 },
    ],
  },
  scopeEstimate: {
    totalHours: 7.42,
    summary:
      'The three packages are in mixed condition. One package (HIPAA Refresher) requires author judgment on keyboard interactions. Two packages (Patient Privacy, Workplace Safety) require assisted fixes and minor cleanup. The Patient Privacy package has a critical content gap (missing captions) that requires 6 hours of effort.',
    recommendation:
      'Recommended engagement shape: 1–2 week project at ~4 hours/week consultant time, plus 1 week for video captioning (content team parallel). Total estimated ~8 hours senior consultant + ~1 week content resources.',
    breakdown: [
      { category: 'Auto-fix safe tier', hours: 0.17 },
      { category: 'Auto-fix assisted tier', hours: 0.5 },
      { category: 'Author rework', hours: 0.75 },
      { category: 'Content rework', hours: 6.0 },
      { category: 'QA re-audit', hours: 0.5 },
    ],
  },
  topRisks: {
    fallback: false,
    risks: [
      {
        title: 'Required compliance training is unreachable by keyboard',
        description:
          'The HIPAA Refresher 2022 course contains custom drag-and-drop interactions that trap keyboard focus. Learners using screen readers or motor accessibility tools cannot complete a training mandated by federal regulation.',
        section508: '501.1',
        wcagCriterion: '2.1.1',
        packageCount: 1,
      },
      {
        title: 'Video-led course has no captions or transcript',
        description:
          'The Patient Privacy 101 course includes a 4:32 embedded video with no synchronized captions or transcript document. Deaf and hard-of-hearing learners have no equivalent path through the content.',
        section508: '501.5',
        wcagCriterion: '1.2.1',
        packageCount: 1,
      },
      {
        title: 'Form feedback conveyed by color alone',
        description:
          'The Workplace Safety Quiz provides feedback on answer correctness through color change only. Learners with color vision deficiency receive no usable feedback.',
        section508: '502',
        wcagCriterion: '1.4.1',
        packageCount: 1,
      },
    ],
  },
  section508Table: [
    {
      reference: '501.1',
      title: 'Operable without specialized input',
      findingCount: 1,
      wcagCriteria: '2.1.1, 2.1.2, 2.4.3',
    },
    {
      reference: '501.5',
      title: 'Captions for synchronized media',
      findingCount: 1,
      wcagCriteria: '1.2.1, 1.2.2',
    },
    {
      reference: '502',
      title: 'Interoperability with assistive tech',
      findingCount: 4,
      wcagCriteria: '1.3.1, 1.4.1, 1.4.3, 4.1.2',
    },
  ],
};

describe('renderMarkdownV3', () => {
  it('should render all 8 sections in correct order', () => {
    const md = renderMarkdownV3(stubScorecard);

    const sections = [
      '# Acme Public Health Authority',
      '## 01 — Executive summary',
      '## 02 — Library health',
      '## 03 — Scope recommendation',
      '## 04 — Top three risks',
      '## 05 — Findings by severity',
      '## 06 — Per-package detail',
      '## 07 — Section 508 mapping',
      '## 08 — Method and scope note',
    ];

    let lastPos = -1;
    sections.forEach(section => {
      const pos = md.indexOf(section);
      expect(pos).toBeGreaterThanOrEqual(0);
      expect(pos).toBeGreaterThan(lastPos);
      lastPos = pos;
    });
  });

  it('should render v3 enrichments', () => {
    const md = renderMarkdownV3(stubScorecard);

    expect(md).toContain('Acme Public Health Authority');
    expect(md).toContain('SL-2026-0418');
    expect(md).toContain('7.42');
    expect(md).toContain('auto-fix safe');
    expect(md).toContain('501.1');
    expect(md).toContain('Required compliance training');
  });

  it('should support redaction of client name', () => {
    const mdRedacted = renderMarkdownV3(stubScorecard, { engagementRedact: true });

    expect(mdRedacted).not.toContain('Acme Public Health');
    expect(mdRedacted).toContain('SL-2026-0418');
  });
});
