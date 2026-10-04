# Security policy

## Supported versions

The latest released minor version receives security fixes.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could expose preview credentials or enable unsafe browser actions. Use GitHub's private vulnerability reporting for `lame13/routeplay`.

Include the affected version, reproduction, impact, and any suggested mitigation. Please do not include live credentials or private target content.

## Credential handling

RoutePlay expands `${ENV_VAR}` placeholders in configured headers and cookies only at runtime. Header, cookie, and storage-state credential values are redacted from terminal, JSON, HTML, SARIF, text artifacts, and baselines. Configured header names are stripped from third-party requests and cross-origin redirects before the browser continues them. Cookies follow Chromium's domain, path, Secure, and SameSite rules: they are not isolated by port, and domain cookies may reach subdomains. Storage state retains its saved cookie scopes and storage origins.

Playwright storage state is read once per run for browser initialization and credential redaction; the file itself is never copied into a report. Keep it out of version control. Screenshots cannot be redacted, and baselines can contain private page content even after credential redaction; review evidence before sharing it.

Users remain responsible for the authorization and safety of sites they test.
