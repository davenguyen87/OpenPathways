# Install Notes

`yazl` is in `dependencies` and installs automatically with `npm install`.

`playwright` is an `optionalDependency` — it's only required for `--simulate` (screen-reader simulation). To enable dynamic checks:

```bash
npm install playwright
npx playwright install chromium
```

Without Playwright, `--simulate` reports `dynamicCheckSkipReason: "playwright not installed"` and the static audit runs normally.

`canvas` remains an `optionalDependency` reserved for future contrast-engine work; it is not used by any active check.
