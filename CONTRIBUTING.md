# Contributing

RoutePlay stays useful by remaining narrow: it proves route-delivery parity across server HTML, cold browser loads, and real anchor transitions. Proposals for generic crawling, SEO scoring, dashboards, or framework-private integrations should start as a discussion before code.

## Setup

```bash
npm ci
npx playwright install chromium
npm run check
```

Use Node.js 22 or 24. Add focused unit coverage for extractors/rules and a synthetic browser fixture for observable navigation behavior. Tests must not depend on external websites.

## Pull requests

- Keep rule IDs stable; add new IDs instead of reusing old semantics.
- Treat external input as untrusted and validate it at the boundary.
- Never log request-header values, cookies, or storage state.
- Avoid full DOM comparisons and `networkidle`.
- Do not force-click, submit forms, or invoke application routers.
- Run `npm run check` and `npm pack --dry-run` before opening a PR.

Small, single-purpose changes are easiest to review.
