/**
 * Verification test for section508.js and top-risks.js
 *
 * Tests the 508 mapping and top-three-risks extraction with stubbed violations.
 * Confirms the ranking algorithm respects severity → urgency → package count → finding count.
 */

import { describe, it, expect } from 'vitest';
import {
  mapWcagTo508,
  mapAllFindings,
  buildSection508Table,
  WCAG_TO_508
} from '../src/lib/section508.js';
import {
  extractTopRisks,
  CRITERION_NAMES,
  FRAMING_TEMPLATES
} from '../src/lib/top-risks.js';

describe('section508.js', () => {
  describe('mapWcagTo508', () => {
    it('should map 1.1.1 to 503.4', () => {
      expect(mapWcagTo508('1.1.1')).toBe('503.4');
    });

    it('should map 1.2.1 to 501.5', () => {
      expect(mapWcagTo508('1.2.1')).toBe('501.5');
    });

    it('should map 1.3.1 to 502.2.1', () => {
      expect(mapWcagTo508('1.3.1')).toBe('502.2.1');
    });

    it('should map 1.4.3 to 502.2.2', () => {
      expect(mapWcagTo508('1.4.3')).toBe('502.2.2');
    });

    it('should map 2.1.1 to 501.1', () => {
      expect(mapWcagTo508('2.1.1')).toBe('501.1');
    });

    it('should map 4.1.2 to 502.2', () => {
      expect(mapWcagTo508('4.1.2')).toBe('502.2');
    });

    it('should return null for unmapped criterion', () => {
      expect(mapWcagTo508('9.9.9')).toBe(null);
    });
  });

  describe('mapAllFindings', () => {
    it('should add section508 field to violations', () => {
      const violations = [
        { criterion: '1.1.1', severity: 'critical', file: 'a.html' },
        { criterion: '1.4.3', severity: 'serious', file: 'b.html' }
      ];

      const result = mapAllFindings(violations);

      expect(result[0].section508).toBe('503.4');
      expect(result[1].section508).toBe('502.2.2');
      expect(result.length).toBe(2);
    });

    it('should mutate in place and return same array', () => {
      const violations = [{ criterion: '1.1.1' }];
      const result = mapAllFindings(violations);

      expect(result).toBe(violations);
      expect(violations[0].section508).toBe('503.4');
    });

    it('should handle violations without criterion', () => {
      const violations = [{ file: 'a.html' }];
      const result = mapAllFindings(violations);

      expect(result[0].section508).toBeUndefined();
    });
  });

  describe('buildSection508Table', () => {
    it('should group violations by 508 reference', () => {
      const violations = [
        { criterion: '1.1.1', section508: '503.4', severity: 'critical' },
        { criterion: '1.1.1', section508: '503.4', severity: 'critical' },
        { criterion: '1.2.1', section508: '501.5', severity: 'serious' }
      ];

      const table = buildSection508Table(violations);

      expect(table.length).toBe(2);
      expect(table[0].reference).toBe('501.5');
      expect(table[0].findingCount).toBe(1);
      expect(table[0].criterionIds).toEqual(['1.2.1']);
      expect(table[1].reference).toBe('503.4');
      expect(table[1].findingCount).toBe(2);
      expect(table[1].criterionIds).toEqual(['1.1.1']);
    });

    it('should sort by reference number (numeric)', () => {
      const violations = [
        { criterion: '3.2.1', section508: '502.3' },
        { criterion: '1.1.1', section508: '503.4' },
        { criterion: '2.1.1', section508: '501.1' }
      ];

      const table = buildSection508Table(violations);

      expect(
        table.map(r => r.reference)
      ).toEqual(['501.1', '502.3', '503.4']);
    });

    it('should include reference titles', () => {
      const violations = [
        { criterion: '1.1.1', section508: '503.4' }
      ];

      const table = buildSection508Table(violations);

      expect(table[0].refTitle).toBe('Audio description and text alternatives');
    });
  });
});

describe('top-risks.js', () => {
  describe('extractTopRisks', () => {
    it('should return empty array when no violations', () => {
      const result = extractTopRisks([]);

      expect(result.risks).toEqual([]);
      expect(result.fallback).toBe(false);
      expect(result.fallbackMessage).toBe(null);
    });

    it('should extract top 3 critical findings ranked by 508 urgency', () => {
      const violations = [
        // Critical tier: keyboard (501.1 = urgent), image (503.4 = less urgent), contrast (502.2.2 = medium)
        { criterion: '1.1.1', severity: 'critical', section508: '503.4', sco: { id: 'pkg1' }, file: 'a.html' },
        { criterion: '2.1.1', severity: 'critical', section508: '501.1', sco: { id: 'pkg1' }, file: 'b.html' },
        { criterion: '1.4.3', severity: 'critical', section508: '502.2.2', sco: { id: 'pkg2' }, file: 'c.html' },
        // Serious tier (should not be in top 3)
        { criterion: '3.3.2', severity: 'serious', section508: '502.3', sco: { id: 'pkg3' }, file: 'd.html' }
      ];

      const result = extractTopRisks(violations);

      expect(result.risks.length).toBe(3);
      expect(result.fallback).toBe(false);
      expect(result.fallbackMessage).toBe(null);

      // Verify ranking: 2.1.1 (501.1) first, then 1.4.3 (502.2.2), then 1.1.1 (503.4)
      expect(result.risks[0].criterion).toBe('2.1.1');
      expect(result.risks[0].section508).toBe('501.1');
      expect(result.risks[1].criterion).toBe('1.4.3');
      expect(result.risks[1].section508).toBe('502.2.2');
      expect(result.risks[2].criterion).toBe('1.1.1');
      expect(result.risks[2].section508).toBe('503.4');
    });

    it('should break ties by package count', () => {
      const violations = [
        // Same severity, same 508 ref, different package counts
        { criterion: '1.1.1', severity: 'critical', section508: '503.4', sco: { id: 'pkg1' }, file: 'a.html' },
        { criterion: '1.1.1', severity: 'critical', section508: '503.4', sco: { id: 'pkg1' }, file: 'a.html' },
        { criterion: '1.3.1', severity: 'critical', section508: '502.2.1', sco: { id: 'pkg1' }, file: 'b.html' },
        { criterion: '1.3.1', severity: 'critical', section508: '502.2.1', sco: { id: 'pkg2' }, file: 'c.html' },
        { criterion: '1.3.1', severity: 'critical', section508: '502.2.1', sco: { id: 'pkg3' }, file: 'd.html' }
      ];

      const result = extractTopRisks(violations);

      // 1.3.1 affects 3 packages, 1.1.1 affects 1 package, both critical, 502.2.1 > 503.4
      // So 1.3.1 should rank first
      expect(result.risks[0].criterion).toBe('1.3.1');
      expect(result.risks[0].packageCount).toBe(3);
    });

    it('should fallback to serious tier when fewer than 3 critical', () => {
      const violations = [
        { criterion: '1.1.1', severity: 'critical', section508: '503.4', sco: { id: 'pkg1' }, file: 'a.html' },
        { criterion: '1.2.1', severity: 'serious', section508: '501.5', sco: { id: 'pkg2' }, file: 'b.html' },
        { criterion: '1.4.3', severity: 'serious', section508: '502.2.2', sco: { id: 'pkg3' }, file: 'c.html' },
        { criterion: '2.1.1', severity: 'serious', section508: '501.1', sco: { id: 'pkg4' }, file: 'd.html' }
      ];

      const result = extractTopRisks(violations);

      expect(result.risks.length).toBe(3);
      expect(result.fallback).toBe(true);
      expect(result.fallbackMessage).toBe('No critical-tier findings; top serious-tier risks are below.');

      // Should have 1 critical + 2 serious
      expect(result.risks[0].severity).toBe('critical');
      expect(result.risks[1].severity).toBe('serious');
      expect(result.risks[2].severity).toBe('serious');
    });

    it('should include risk cards with all required fields', () => {
      const violations = [
        { criterion: '1.1.1', severity: 'critical', section508: '503.4', sco: { id: 'pkg1' }, file: 'a.html' }
      ];

      const result = extractTopRisks(violations);
      const risk = result.risks[0];

      expect(risk.rank).toBe(1);
      expect(risk.criterion).toBe('1.1.1');
      expect(risk.criterionName).toBe('Non-text content');
      expect(risk.section508).toBe('503.4');
      expect(risk.section508Title).toBe('Audio description and text alternatives');
      expect(risk.severity).toBe('critical');
      expect(risk.packageCount).toBe(1);
      expect(risk.findingCount).toBe(1);
      expect(typeof risk.framing).toBe('string');
      expect(risk.framing.length).toBeGreaterThan(0);
    });

    it('should include framing sentence with regulated-learner language', () => {
      const violations = [
        { criterion: '1.1.1', severity: 'critical', section508: '503.4', sco: { id: 'pkg1' }, file: 'a.html' },
        { criterion: '1.1.1', severity: 'critical', section508: '503.4', sco: { id: 'pkg2' }, file: 'b.html' }
      ];

      const result = extractTopRisks(violations);
      const risk = result.risks[0];

      // Should mention package count and learner impact
      expect(risk.framing).toContain('2 packages');
      expect(risk.framing).toContain('Screen-reader');
    });
  });

  describe('CRITERION_NAMES and FRAMING_TEMPLATES', () => {
    it('should have names for all audited criteria', () => {
      const auditedCriteria = [
        '1.1.1', '1.2.1', '1.2.2', '1.3.1', '1.3.4', '1.3.5', '1.4.1', '1.4.2', '1.4.3', '1.4.4', '1.4.10', '1.4.11',
        '2.1.1', '2.1.2', '2.4.7', '2.4.11', '2.5.7', '2.5.8', '3.3.2', '3.3.8', '4.1.2'
      ];

      for (const criterion of auditedCriteria) {
        expect(CRITERION_NAMES[criterion]).toBeTruthy();
      }
    });

    it('should have framing templates for high-impact criteria', () => {
      const templateCriteria = ['1.1.1', '1.2.1', '1.4.3', '2.1.1', '2.4.7', '4.1.2'];

      for (const criterion of templateCriteria) {
        expect(FRAMING_TEMPLATES[criterion]).toBeTruthy();
      }
    });
  });
});
