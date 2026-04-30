# Publishing Open Pathways to npm

Follow this checklist when ready to publish a new version to npm.

## Pre-publish checklist

1. Verify version in `package.json` matches `CHANGELOG.md`
   ```bash
   node -p "require('./package.json').version"
   grep "^## \[" CHANGELOG.md | head -1
   ```

2. Run the full test suite and confirm all tests pass
   ```bash
   npm test
   ```
   Expected: 52 tests pass

3. Run a smoke test on a real fixture
   ```bash
   node src/cli.js test/fixtures/scorm12-violations.zip
   ```

4. Verify the npm pack payload (dry-run)
   ```bash
   npm pack --dry-run
   ```
   Confirm that:
   - All `src/**/*.js` files are present
   - `README.md`, `CHANGELOG.md`, `package.json` are present
   - `docs/CONTRACT.md` and `docs/DYNAMIC_CHECKS.md` are included
   - `test/`, `archive/`, `node_modules/` are NOT included
   - Total size is under 1 MB

## Publishing

5. Log into npm (if not already logged in)
   ```bash
   npm login
   ```

6. Test publish against npm registry (dry-run, no actual upload)
   ```bash
   npm publish --access public --dry-run
   ```

7. Publish to npm
   ```bash
   npm publish --access public
   ```

8. Verify the package was published
   ```bash
   npm view open-pathways@$(node -p "require('./package.json').version")
   ```

## Post-publish

9. Tag the commit with the version
   ```bash
   git tag v$(node -p "require('./package.json').version")
   git push origin --tags
   ```

10. Announce the release (optional)
    - Update any documentation that references the tool
    - Post to relevant channels or communities

---

**Note**: This file is a guide for the maintainer (Dave Nguyen, davenguyen87@gmail.com). The automated publish workflow (if set up) should follow these same steps.
