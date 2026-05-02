// Phase 6 listener-leak regression test.
//
// Before Phase 6, audit() registered a fresh process.on('exit') listener
// on every call. After ~10 calls Node logged a MaxListenersExceededWarning,
// and after thousands the process slowed noticeably. This test pins the
// fix in place: 30 sequential audit() calls must NOT grow the 'exit'
// listener count, and Node must not emit any MaxListenersExceededWarning
// during the run.
//
// 30 iterations is enough to catch the regression (the old code would
// already have triggered the warning at 11). Running 200 (per the roadmap
// success criterion) would just slow the suite — the listener-count
// assertion is a stronger signal than wall-clock survival.

import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { audit } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'scorm12-clean.zip');
const ITERATIONS = 30;

describe('audit() listener-leak regression', () => {
  it(
    `${ITERATIONS} sequential audits keep process.listenerCount('exit') flat and emit no MaxListenersExceededWarning`,
    async () => {
      // Capture any warnings node emits during the run.
      const warnings = [];
      const onWarning = (w) => warnings.push(w);
      process.on('warning', onWarning);

      const before = process.listenerCount('exit');

      try {
        for (let i = 0; i < ITERATIONS; i++) {
          // We don't care about the result here — only that the process
          // state stays clean. Errors are tolerated (a bad fixture would
          // still register the cleanup listener under the old code).
          await audit(FIXTURE, { browser: 'chromium' }).catch(() => {});
        }
      } finally {
        process.off('warning', onWarning);
      }

      const after = process.listenerCount('exit');

      // Listener count must not grow per call. The module's single
      // exit-handler may have been registered during this run if it wasn't
      // already, so we allow at most one growth — but multiple calls must
      // not each add their own handler.
      expect(after - before).toBeLessThanOrEqual(1);

      const maxListenersWarnings = warnings.filter(
        (w) => w && w.name === 'MaxListenersExceededWarning'
      );
      expect(maxListenersWarnings).toEqual([]);
    },
    600000 // 10-minute budget; 30 audits ≈ 2-3 minutes locally.
  );
});
