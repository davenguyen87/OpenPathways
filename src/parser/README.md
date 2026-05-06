# Package Parser

Detects and parses SCORM 1.2, SCORM 2004, AICC, cmi5, and xAPI packages. Returns package type, HTML entry points, and the parsed manifest structure.

## Detection Order

1. **SCORM**: If `imsmanifest.xml` is present at any depth (prefers shallowest).
   - **SCORM 1.2**: `imsmanifest.xml` without `schemaversion` attribute or with schemaversion < 2004.
   - **SCORM 2004**: `imsmanifest.xml` with `schemaversion` containing "2004" OR namespaces indicating SCORM 2004 (`imscp_v1p1` + `adlcp_v1p3`/`imsss`).
2. **AICC**: If any `*.crs` file is present at any depth.
3. **cmi5**: If `cmi5.xml` is present at the package root.
4. **xAPI**: If `tincan.xml` is present at the package root.
5. **Error**: If none are found, throw `"Could not detect a valid SCORM, AICC, xAPI, or cmi5 manifest."`

## SCORM Parsing

### Detection and Parsing
- Reads `imsmanifest.xml`
- Walks `<organizations>` → `<organization>` → `<item>` tree, collecting `identifierref` attributes
- Resolves each `identifierref` via `<resources>` → `<resource>` to extract `href` attributes
- For each resource, also checks `<file>` child elements if present
- Resolves relative paths using `xml:base` attributes (checked at resource, organization, and manifest levels)
- Includes HTML, HTM, and asset resources (no filtering by `adlcp:scormtype`)

### Entry Points
- Array of unique HTML/HTM file paths (normalized to forward slashes)
- Preserves query strings in hrefs (e.g., `launch.html?mode=normal`)
- Deduplicates by absolute path

### Manifest Shape
```json
{
  "version": "scorm12 or scorm2004",
  "schemaversion": "1.2 or 2004 or detected version",
  "defaultOrganization": "identifier of default org",
  "organizations": { /* raw parsed <organizations> element */ },
  "resources": { /* raw parsed <resources> element */ }
}
```

## AICC Parsing

### File Format Support
- `.crs`: INI-like format with sections (`[Course]`, `[Course_Behavior]`, etc.) and key=value pairs
- `.au`: CSV format with header row; required columns: `System_ID`, `File_Name`
- `.des`: Descriptor file (optional; indicates profile 2)
- `.cst`: Course structure file (optional; profile 3+ triggers error)

### Profile Support
- **Profile 1**: Requires `.crs` + `.au` only.
- **Profile 2**: Adds optional `.des` file.
- **Profile 3+**: If `.cst` contains `Block` or `Prerequisites` patterns, throws error: `"AICC profile 3/4 is not supported. Only profiles 1 and 2 are supported."`

### Entry Points
- Array of `File_Name` values from `.au` CSV (deduplicaled)
- Normalized to forward slashes
- Includes both HTML/HTM files and unconventional file types (wrappers, SCORM shims)
- If any non-HTML file types are included, stored in `manifest.aicc.unconventionalEntries`

### Manifest Shape
```json
{
  "version": "aicc",
  "profile": 1 or 2,
  "courseInfo": {
    "creator": "string or null",
    "id": "string or null",
    "version": "string or null"
  },
  "crs": { /* parsed INI structure: { sectionName: { key: value } } */ },
  "unconventionalEntries": ["file1.asp", ...] /* only if present */
}
```

## xAPI / Tin Can Parsing

### File Format Support
- `tincan.xml`: Tin Can API package descriptor at the package root
  - Root element: `<tincan xmlns="http://projecttincan.com/tincan.xsd">`
  - Contains `<activities>` element with one or more `<activity>` elements
  - Each activity has:
    - `id` attribute (e.g., `https://example.com/activities/lesson-1`)
    - `type` attribute (e.g., `http://adlnet.gov/expapi/activities/lesson`)
    - `<name>` element (activity display name)
    - `<description>` element (optional)
    - `<launch>` element (relative or absolute URL to content; relative paths are treated as entry points)

### Entry Points
- Array of relative paths from `<launch>` elements
- Absolute URLs (http://, https://) are skipped (external resources)
- Normalized to forward slashes
- Deduplicated

### SCOs
- One SCO per launchable activity (activity with a non-external `<launch>`)
- Shape: `{ id: activity.id, title: activity.name || activity.id, entryFile: <launch path> }`

### Manifest Shape
```json
{
  "version": "xapi",
  "tincantPackageType": "tincan",
  "activitiesCount": number,
  "launchableCount": number
}
```

### Error Handling
- If `tincan.xml` is missing at package root → throw `"tincan.xml not found at package root"`
- If no activities have a `<launch>` element → return `{ errors: ["xAPI package has no launchable activities"] }`
- Malformed XML → propagated from `xml2js` parser

## cmi5 Parsing

### File Format Support
- `cmi5.xml`: cmi5 course structure XML at the package root
  - Root element: `<courseStructure xmlns="https://w3id.org/xapi/profiles/cmi5/v1.0/CourseStructure.xsd">`
  - Contains nested `<au>` (Assignable Unit) elements with `<url>` children
  - Each AU has an `id` attribute and `<url>` element pointing at the launchable content

### Entry Points
- Array of relative paths from `<url>` elements inside `<au>` blocks
- Absolute URLs (http://, https://) are skipped (external resources)
- Normalized to forward slashes
- Deduplicated

### Modules
The cmi5 parser shares the same general output shape as xAPI: one entry per launchable AU. See `src/parser/cmi5.js` for the detailed shape.

## Edge Cases Handled

- **BOM stripping**: UTF-8 BOM is stripped from XML and INI files before parsing
- **Case-insensitive file search**: `.crs`, `.au`, `.des`, `.cst` and `imsmanifest.xml` are found regardless of case
- **Windows paths**: All backslashes normalized to forward slashes in output
- **Shallow manifest location**: Prefers `imsmanifest.xml` at the shallowest depth in the directory tree
- **Query strings in hrefs**: Preserved in entry point output (e.g., `launch.html?mode=normal`)
- **Quoted CSV fields**: CSV parser handles quoted fields with embedded commas correctly

## Error Cases

- No manifest detected → `"Could not detect a valid SCORM, AICC, xAPI, or cmi5 manifest."`
- AICC profile 3/4 → `"AICC profile 3/4 is not supported. Only profiles 1 and 2 are supported."`
- Malformed XML → propagated from `xml2js` parser
- Malformed INI/CSV → best-effort parsing (skips malformed rows)

## Modules

- `index.js` — Main entry point, type detection dispatch
- `detect.js` — Package type detection logic
- `scorm.js` — SCORM 1.2 + 2004 parser (uses xml2js)
- `aicc.js` — AICC parser (INI and CSV parsing)
- `cmi5.js` — cmi5 course-structure parser (uses xml2js)
- `xapi.js` — xAPI / Tin Can parser (uses xml2js)
- `util.js` — Shared utilities: file search, text reading, CSV/INI parsing
