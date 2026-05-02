const path = require('path');
const { loadDynamicChecks } = require('./load-dynamic-checks');
const axTreeAdapter = require('./ax-tree-adapter');

/**
 * Runs dynamic checks against a SCORM package.
 * Orchestrates Playwright browser lifecycle, loads entry point HTML files,
 * captures accessibility tree snapshots, and invokes dynamic checks.
 *
 * Optional progress hook: pass options.onProgress(event). Used by the web UI.
 * Emits, in addition to whatever the caller emits around the wrapper:
 *   dynamic-page  { path, index, total }   per entry-point page load
 *   dynamic-check { id, name, index, total } per dynamic check invocation
 * The hook is best-effort — exceptions are swallowed so a misbehaving
 * subscriber can never break a dynamic run.
 *
 * Cancellation contract (Phase 6)
 * -------------------------------
 * Pass options.signal (AbortSignal) to make this runner cancellable. When
 * the signal fires we close the Playwright browser immediately — that
 * unblocks any in-flight page.goto() within Playwright's connection
 * teardown — and we throw an AbortError on the next inter-page or
 * inter-check boundary. Net effect: cancel-to-stop is ~1 second on a
 * dynamic-phase audit even if a single page is mid-navigation.
 *
 * @param {object} ctx - AuditContext (with packageRoot, entryPoints, files, etc.)
 * @param {object} options - { browser: 'chromium'|'firefox'|'webkit', timeout: number, headless: bool, onProgress?: function, signal?: AbortSignal }
 * @returns {Promise<{ violations: Array, iframeWarnings: Array, skipped: bool, reason?: string }>}
 */
async function runDynamicChecks(ctx, options = {}) {
  const {
    browser: browserType = 'chromium',
    timeout = 30000,
    headless = true,
    onProgress = null,
    signal = null,
  } = options;

  const emit = typeof onProgress === 'function'
    ? (stage, details) => {
        try { onProgress({ stage, ts: Date.now(), ...(details || {}) }); }
        catch (_) { /* swallow — see docstring */ }
      }
    : () => {};

  // Throw an AbortError if the caller's signal has fired. No-op when null.
  const throwIfAborted = () => {
    if (signal && signal.aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }
  };

  // Try to require Playwright; fail gracefully if not installed
  let playwright;
  try {
    playwright = require('playwright');
  } catch (err) {
    return {
      violations: [],
      iframeWarnings: [],
      skipped: true,
      reason: 'playwright not installed',
    };
  }

  // Dynamic checks rely on CDP (Chrome DevTools Protocol) for the Accessibility
  // Tree. Firefox and WebKit don't expose CDP, so per-page snapshots would all
  // return null. Fail fast with a clear message rather than emit one warning
  // per entry point.
  if (browserType !== 'chromium') {
    return {
      violations: [],
      iframeWarnings: [],
      skipped: true,
      reason: `dynamic checks require chromium (got --browser ${browserType}). The Accessibility Tree is captured via CDP, which firefox/webkit don't implement. Re-run with --browser chromium.`,
    };
  }

  let browserInstance = null;
  let onAbort = null;

  try {
    throwIfAborted();

    // Launch browser
    browserInstance = await playwright[browserType].launch({
      headless,
    });

    // Phase 6: when the caller's signal fires, close the browser eagerly.
    // That makes any in-flight page.goto() reject within Playwright's
    // connection teardown (typically <1s) instead of waiting out the
    // 30-second navigation timeout.
    if (signal) {
      onAbort = () => {
        if (browserInstance) {
          // Fire-and-forget; we don't await here so the abort listener
          // returns immediately. The finally block below also tries close.
          browserInstance.close().catch(() => {});
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    // Store page records in context for dynamic checks to use
    ctx.pages = [];
    ctx.axTree = new Map();

    // Load each entry point HTML file
    for (let i = 0; i < ctx.entryPoints.length; i++) {
      throwIfAborted();
      const entryPoint = ctx.entryPoints[i];
      emit('dynamic-page', {
        path: entryPoint,
        index: i + 1,
        total: ctx.entryPoints.length,
      });
      const filePath = path.join(ctx.packageRoot, entryPoint);
      const fileUrl = `file://${filePath}`;

      let pageRecord = {
        path: entryPoint,
        page: null,
        url: fileUrl,
        axTree: null,
        error: null,
      };

      try {
        // Create a new context per page for isolation
        const context = await browserInstance.newContext();
        const page = await context.newPage();

        // Navigate to the file with timeout
        try {
          await page.goto(fileUrl, {
            waitUntil: 'domcontentloaded',
            timeout: timeout,
          });
        } catch (navErr) {
          throw new Error(`Failed to load ${entryPoint}: ${navErr.message}`);
        }

        // Small idle wait to allow initial scripts to run
        await page.waitForTimeout(500);

        // Capture accessibility tree snapshot
        const axTree = await axTreeAdapter.snapshot(page);
        if (!axTree) {
          throw new Error(
            'accessibility tree unavailable for this browser (CDP unsupported on firefox/webkit, and page.accessibility was removed in Playwright >= 1.45). Use --browser chromium.'
          );
        }

        // The CDP AX tree does NOT carry explicit `tabindex` values — that
        // attribute is consumed by the browser's focus engine and not exposed
        // as an AXProperty. Pull it directly from the DOM so the 2.4.3 check
        // can spot positive-tabindex anti-patterns.
        const explicitTabindex = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('[tabindex]')).map((el) => ({
            tag: el.tagName ? el.tagName.toLowerCase() : null,
            tabindex: parseInt(el.getAttribute('tabindex'), 10),
            text: (el.textContent || '').trim().slice(0, 80),
            outerHTML: (el.outerHTML || '').slice(0, 200),
          }));
        });

        pageRecord.page = page;
        pageRecord.axTree = axTree;
        pageRecord.explicitTabindex = explicitTabindex;

        // Store in context for checks to access
        ctx.pages.push(pageRecord);
        ctx.axTree.set(entryPoint, axTree);

        // Don't close context yet; checks may need the page object
        pageRecord.context = context;
      } catch (err) {
        pageRecord.error = err.message;
        ctx.pages.push(pageRecord);
        console.warn(`Dynamic check: failed to load ${entryPoint}: ${err.message}`);
      }
    }

    // Load dynamic checks
    const dynamicChecks = await loadDynamicChecks();

    // Run each check against the context
    const violations = [];
    const iframeWarnings = [];

    for (let i = 0; i < dynamicChecks.length; i++) {
      throwIfAborted();
      const check = dynamicChecks[i];
      emit('dynamic-check', {
        id: check.id,
        name: check.name,
        index: i + 1,
        total: dynamicChecks.length,
      });
      try {
        const checkViolations = await check.run(ctx);
        if (Array.isArray(checkViolations)) {
          violations.push(...checkViolations);
        }
      } catch (err) {
        console.error(`Dynamic check ${check.id} error: ${err.message}`);
      }
    }

    // Scan for external iframes in all HTML files
    for (const htmlFile of ctx.files.html) {
      const iframeRegex = /<iframe[^>]+src=["']([^"']+)["']/gi;
      let match;

      while ((match = iframeRegex.exec(htmlFile.content)) !== null) {
        const iframeUrl = match[1];

        // Check if external (http://, https://, //)
        if (
          iframeUrl.startsWith('http://') ||
          iframeUrl.startsWith('https://') ||
          iframeUrl.startsWith('//')
        ) {
          // Find line number of this iframe
          const lineNum = require('./line-of').lineOf(htmlFile.content, match[0]);

          iframeWarnings.push({
            file: htmlFile.path,
            iframeUrl: iframeUrl,
            line: lineNum,
          });
        }
      }
    }

    // Close all page contexts
    for (const pageRecord of ctx.pages) {
      if (pageRecord.context) {
        try {
          await pageRecord.context.close();
        } catch (err) {
          // Ignore close errors
        }
      }
    }

    return {
      violations,
      iframeWarnings,
      skipped: false,
    };
  } catch (err) {
    // Re-throw cancellation so audit() can propagate it as a clean cancel
    // rather than treating it as a partial / "skipped" dynamic phase.
    if (err && err.name === 'AbortError') throw err;

    // Unexpected error; return gracefully
    console.error(`Dynamic checks orchestration error: ${err.message}`);
    return {
      violations: [],
      iframeWarnings: [],
      skipped: true,
      reason: `orchestration error: ${err.message}`,
    };
  } finally {
    if (signal && onAbort) {
      try { signal.removeEventListener('abort', onAbort); } catch (_) {}
    }
    // Always close browser
    if (browserInstance) {
      try {
        await browserInstance.close();
      } catch (err) {
        // Ignore close errors
      }
    }
  }
}

module.exports = { runDynamicChecks };
