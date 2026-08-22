# Changelog

All notable changes to RoutePlay are documented here. The project follows Semantic Versioning.

## Unreleased

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
