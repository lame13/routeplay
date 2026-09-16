# RoutePlay

[![CI](https://github.com/lame13/routeplay/actions/workflows/ci.yml/badge.svg)](https://github.com/lame13/routeplay/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/routeplay.svg)](https://www.npmjs.com/package/routeplay)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Regression-test what an SSR server returns, what a fresh browser renders, and what users get after navigating through the app.

RoutePlay captures three semantic surfaces for every configured route transition:

1. the untouched server response HTML;
2. the settled DOM after a cold direct load in Chromium;
3. the settled DOM after clicking a real in-app `<a href>` from another route.

It then compares route identity, SEO metadata, primary content, crawlable links, structured data, navigation mode, and browser failures. Optional route contracts can also require specific content on all three surfaces. RoutePlay is deliberately not a crawler, Lighthouse wrapper, or generic SEO score.

## Why this exists

SSR regressions often hide behind a working client router:

- a route works through `Link`/`NuxtLink` but fails on refresh or direct entry;
- meaningful content or links appear only after JavaScript;
- hydration changes the title, canonical, robots directives, H1, or JSON-LD;
- a persistent layout leaves stale metadata after soft navigation;
- a browser-only global crashes the direct render path;
- an internal link is visually clickable but has no crawlable `href`;
- a destination link exists only after JavaScript and is absent from the source page;
- every surface agrees on the same wrong title, canonical, heading, or critical copy;
- an Astro page unexpectedly performs a document navigation, or a `ClientRouter` swap keeps stale state.

RoutePlay turns those into repeatable CI evidence instead of a manual “view source, click around, refresh” ritual.

## Requirements

- Node.js 22 or newer
- Chromium installed for the pinned Playwright version

```bash
npm install --save-dev routeplay
npx routeplay install
```

From a source checkout:

```bash
npm ci
npx playwright install chromium
npm run build
node dist/cli.js --help
```

## Quick start

Create a config:

```bash
npx routeplay init
```

Edit `routeplay.config.json`:

```json
{
  "$schema": "./node_modules/routeplay/routeplay.schema.json",
  "baseUrl": "https://example.com",
  "transitions": [
    {
      "name": "Home to pricing",
      "from": "/",
      "to": "/pricing/",
      "expectedFinalUrl": "/pricing/",
      "selector": "a[href='/pricing/']",
      "mainSelector": "main",
      "readySelector": "main h1",
      "ignoreSelectors": ["time", "[data-live-price]"],
      "expectedStatus": 200,
      "requireClientNavigation": true,
      "expect": {
        "title": "Pricing | Example",
        "canonical": "/pricing/",
        "h1": ["Pricing"],
        "mainTextIncludes": ["Choose a plan"],
        "linksInclude": ["/signup/"]
      }
    }
  ]
}
```

Validate the config without launching Chromium:

```bash
npx routeplay validate
```

Run it:

```bash
npx routeplay check
npx routeplay check --artifacts routeplay-artifacts
npx routeplay check --format html --output routeplay-report.html
npx routeplay check --format json --output routeplay-report.json
npx routeplay check --format sarif --output routeplay.sarif
```

One-off mode needs no config:

```bash
npx routeplay check \
  --base-url https://example.com \
  --from / \
  --to /pricing/
```

## What it compares

| Signal | Server → cold | Cold → transition |
|---|---:|---:|
| Final route URL | HTTP evidence | Error on drift |
| Title and description | Warning | Error |
| Canonical and meta robots | Warning | Error |
| H1 set | Warning | Error |
| Main-content shingles | Configurable warning | Configurable error |
| Crawlable internal hrefs | Warning | Error |
| JSON-LD block fingerprints / invalid JSON | Warning | Error / warning |
| Page, console, request, and HTTP failures | Captured | Captured |
| Client vs document navigation | — | Evidence or required contract |
| Explicit route contract | Error | Error |

Server/cold mismatches are warnings by default because client enhancement can be intentional. Cold/transition mismatches are errors because the same destination has two browser-visible states. Use `"failOn": "warning"` for a strict SSR gate.

RoutePlay compares semantic fields, not complete DOM strings. Framework hydration markers, nonces, preload ordering, and analytics mutations do not create noise.

## Configuration

The full JSON Schema is [routeplay.schema.json](routeplay.schema.json). Useful controls:

- `selector`: exact anchor to click. It must resolve to a same-origin, same-tab `<a href>`.
- `expectedFinalUrl`: allowed final route after server/client redirects, defaulting to `to`.
- `mainSelector`: stable route content, defaulting to `main` and falling back to `body`.
- `ignoreSelectors`: dynamic regions removed from main-text comparison.
- `readySelector`: an element that must exist before semantic stabilization begins.
- `expectedStatus`: expected direct response status, default `200`.
- `requireClientNavigation`: fail when the click causes a document navigation.
- `expect`: values that must be present in the server response, cold load, and in-app result.
- `browser.timeoutMs`: bounded navigation/readiness timeout, default `20000`.
- `browser.settleMs`: time the semantic signature must remain unchanged, default `500`.
- `compare.minTextSimilarity`: word-shingle Dice threshold, default `0.98`.
- `compare.minSourceTextLength`: warning threshold for thin server content, default `80`.
- `failOn`: `error`, `warning`, or `never`.
- `concurrency`: transitions captured at once, from `1` to `8`, default `1`. Override with `--concurrency`. Every transition still gets its own clean browser contexts.
- `retries`: extra attempts for a transition that is incomplete or still violates the configured policy, from `0` to `3`, default `0`. Override with `--retries`.
- `artifacts`: directory for failure evidence. The `--artifacts` flag overrides it for one run.

RoutePlay never uses `networkidle`. It waits for DOM content, an optional readiness selector, and a bounded stable semantic signature, so analytics and long-lived requests cannot hang a run.

## Route contracts

Parity alone cannot catch a mistake shared by every surface. A route contract states what the destination must contain:

```json
{
  "from": "/products/",
  "to": "/products/widget/",
  "expect": {
    "title": "Widget | Example",
    "description": "See Widget features, specifications, and pricing.",
    "canonical": "/products/widget/",
    "h1": ["Widget"],
    "robots": {
      "robots": ["follow", "index"]
    },
    "jsonLdTypesInclude": ["Product"],
    "mainTextIncludes": ["Widget specifications", "Start free"],
    "linksInclude": ["/signup/", "/support/widget/"]
  }
}
```

`title`, `description`, `canonical`, and `h1` are exact. Exact title, description, and canonical checks also catch duplicate elements. Each configured robots user agent must have exactly the listed directives; other user agents are left alone. `jsonLdTypesInclude`, `mainTextIncludes`, and `linksInclude` require those values without forbidding additional content.

Text uses the same whitespace normalization as captured pages and remains case-sensitive. Relative canonical and link values resolve against `baseUrl`; fragments are ignored for required links because crawlable-link comparison ignores them too. Contract failures are errors and identify the affected surface or surfaces. Explicit `linksInclude` checks still run when `compare.compareLinks` is `false`.

## Protected previews

Headers can reference environment variables:

```json
{
  "headers": {
    "x-vercel-protection-bypass": "${VERCEL_AUTOMATION_BYPASS_SECRET}",
    "x-vercel-set-bypass-cookie": "true"
  }
}
```

Header values are expanded at runtime, removed from every report field, and attached only to requests for the audited origin. Chromium request interception explicitly strips those names from third-party requests and cross-origin redirects. Credentialed preview interception can change cache behavior, while normal header-free runs preserve browser caching.

For an ephemeral one-off run:

```bash
npx routeplay check --config routeplay.config.json \
  --header "x-preview-token=$PREVIEW_TOKEN"
```

Environment-backed config is safer in CI because command arguments may be visible to other processes.

## Failure artifacts

Text evidence rarely explains a browser-only regression on its own. Point RoutePlay at a directory and it writes what it saw for the transitions that failed:

```bash
npx routeplay check --artifacts routeplay-artifacts
```

```text
routeplay-artifacts/
└── 01-home-to-pricing/
    ├── cold.png         settled destination after a direct load
    ├── cold.html        settled DOM after a direct load
    ├── source.png       source page, when loading it or clicking failed
    ├── source.html
    ├── transition.png   settled destination after the in-app click
    ├── transition.html
    └── runtime.json     console, page, request, and HTTP evidence per surface
```

Screenshots and DOM are collected while transitions run but written only for the final failing attempt of a transition that fails or stays incomplete. Passing transitions leave the directory untouched, and retried failures report the attempt they kept. Directory names are prefixed with the configured transition index, so two transitions with the same name never collide.

Reusing a directory replaces that failing transition's previous evidence files. DOM and screenshots are best effort when navigation fails before a document is available; runtime evidence still records request failures. Transition durations include every retry attempt.

Artifact HTML and JSON reuse report redaction, so reflected preview credentials become `[REDACTED]`. Screenshots are pixels and cannot be redacted: do not publish artifacts from pages that render secrets. The JSON and HTML reports list the written files under `results[].artifacts`, relative to the artifacts directory.

## Framework behavior

RoutePlay is framework-neutral at the HTTP/browser boundary and is designed for these route behaviors:

- Next.js App Router and Pages Router: real anchors emitted by `Link` are clicked with normal prefetch behavior intact.
- Nuxt universal, prerendered, and hybrid routes: `NuxtLink` transitions are observed without reading router internals.
- Astro MPA, cross-document View Transitions, and `ClientRouter`: document identity distinguishes actual client swaps from full loads.

See [framework notes](examples/frameworks.md) for readiness and test-pair guidance.

## Reports and exit codes

- `terminal`: concise local output with evidence and fix hints.
- `json`: schema-versioned machine-readable results.
- `html`: self-contained shareable report with a route-by-route matrix.
- `sarif`: stable rule IDs for GitHub Code Scanning.

Exit codes are stable:

- `0`: the complete run passed the configured policy;
- `1`: the run completed and violated the configured policy;
- `2`: configuration, setup, capture, or incomplete-evidence failure.

An incomplete transition is never reported as a pass.

## CI

Copy [examples/github-actions.yml](examples/github-actions.yml) into the audited project's `.github/workflows/` directory and commit its `routeplay.config.json`. Reports can be uploaded as artifacts or SARIF, and `--artifacts routeplay-artifacts` keeps screenshots, DOM, and runtime events available for the failed run.

This repository's own CI tests Node.js 22 and 24, runs real Chromium against synthetic SSR/SPA failure fixtures, builds the Docker image and package, and validates the npm tarball. It does not claim framework-internal integration coverage.

## Docker

The image uses Microsoft's matching Playwright base image:

```bash
docker build -t routeplay .
docker run --rm --ipc=host \
  -v "$PWD/routeplay.config.json:/work/routeplay.config.json:ro" \
  -v "$PWD/reports:/work/reports" \
  -w /work \
  routeplay check --config routeplay.config.json --format html --output reports/routeplay.html
```

The image runs as the non-root `pwuser`. Make mounted report directories writable by that user. For a managed local Chromium binary, set `ROUTEPLAY_CHROMIUM_PATH` to its absolute path. The default local setup is `routeplay install`.

## Safety and scope

RoutePlay only clicks configured or auto-matched same-origin anchors. It never clicks arbitrary buttons, submits forms, follows downloads, or calls application router APIs. Every transition gets clean browser contexts, service workers are blocked for deterministic capture, and preview credentials remain origin-scoped.

It does not discover a whole site, infer dynamic route samples, validate every SEO best practice, compare bot-specific user agents automatically, or replace a crawler. `X-Robots-Tag` and redirect chains are retained as HTTP evidence in JSON, but only HTML meta robots participate in parity rules. Keep the route list small and valuable: listing → detail, category → article, valid → explicit missing route, locale switches, and A ↔ B pairs where persistent state matters.

## Development

```bash
npm ci
npx playwright install chromium
npm run check
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [CHANGELOG.md](CHANGELOG.md).

MIT licensed. Built by [Niko M.](https://nikom.work).
