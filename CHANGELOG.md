# Changelog

All notable changes to RoutePlay are documented here. The project follows Semantic Versioning.

## Unreleased

## 0.4.0 - 2026-09-16

### Added

- Added optional failure artifacts with per-surface DOM, full-page screenshots, and runtime/HTTP evidence, using index-prefixed transition directories and retaining the final failing attempt.
- Added configurable transition concurrency (`1`–`8`) and retries (`0`–`3`), with matching CLI flags and configured result order preserved.
- Added run settings, attempt counts, and artifact paths to reports, plus failure artifact uploads in the CI example.

### Changed

- Replaced repeated HTML serialization and parsing during stability polling with an in-page semantic signature. Final report extraction remains unchanged, and sampling does not invoke custom-element constructors.
- Transition durations include all retry attempts. Artifact write failures wait for active workers to finish before returning.

### Fixed

- Retained available evidence for early navigation failures, replaced stale files when reusing a failing transition's artifact directory, and kept passing runs from creating artifact directories.
- Redacted HTML-escaped credentials in artifact text and rejected empty artifact directory overrides.

## 0.3.0 - 2026-09-04

### Added

- Added optional per-transition route contracts for exact title, description, canonical, H1, and robots expectations across server HTML, cold loads, and in-app navigation.
- Added required JSON-LD type, main-content text, and crawlable-link checks with compact per-surface evidence in every report format.

## 0.2.0 - 2026-08-28

### Added

- Added `routeplay validate` for checking configuration without launching Chromium.

### Changed

- Migrated npm releases to Trusted Publishing with GitHub Actions OIDC, removing the long-lived registry token.

## 0.1.3 - 2026-08-22

### Fixed

- Report rejected npm publishing credentials with the exact token requirements needed for first-time package publication.

## 0.1.2 - 2026-08-22

### Fixed

- Verify npm authentication before publishing and target the public npm registry explicitly.

## 0.1.1 - 2026-08-22

### Fixed

- Kept the TypeScript toolchain compatible with the current `tsup` declaration build so automated dependency updates cannot break packaging.
- Updated GitHub Actions runners to the current Node.js 24-based action releases.

## 0.1.0 - 2026-08-21

### Added

- Raw server, cold Chromium, and real-anchor transition captures.
- Semantic parity rules for URL, metadata, H1, main text, links, and JSON-LD.
- Browser page, console, request, and HTTP diagnostics.
- Client/document navigation detection.
- Strict JSON configuration with environment-backed origin-scoped headers.
- Terminal, JSON, self-contained HTML, and SARIF reports.
- Stable exit codes, `init`, `doctor`, and matching-Chromium `install` commands.
- CI, Docker, framework guidance, synthetic browser fixtures, and package validation.
