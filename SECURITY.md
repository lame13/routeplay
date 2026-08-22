# Security policy

## Supported versions

The latest released minor version receives security fixes.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could expose preview credentials or enable unsafe browser actions. Use GitHub's private vulnerability reporting for `lame13/routeplay`.

Include the affected version, reproduction, impact, and any suggested mitigation. Please do not include live credentials or private target content.

## Credential handling

RoutePlay expands `${ENV_VAR}` placeholders only at runtime. Header values are removed from terminal, JSON, HTML, and SARIF fields. Configured header names are stripped from third-party requests and cross-origin redirects before the browser continues them.

Users remain responsible for the authorization and safety of sites they test.
