import { readFileSync } from "node:fs";
import type { Browser } from "playwright";
import { launchBrowser, runTransition } from "./browser.js";
import type { RoutePlayConfig, RoutePlayReport, RunSummary, Severity } from "./types.js";

function readPackageVersion(): string {
  const metadata = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as unknown;
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("version" in metadata) ||
    typeof metadata.version !== "string"
  ) {
    throw new Error("RoutePlay package metadata has no valid version.");
  }
  return metadata.version;
}

export const VERSION = readPackageVersion();

function redactUnknown(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") {
    return secrets.reduce(
      (current, secret) =>
        current
          .replaceAll(secret, "[REDACTED]")
          .replaceAll(encodeURIComponent(secret), "[REDACTED]"),
      value,
    );
  }
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, secrets));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, redactUnknown(nested, secrets)]),
  );
}

export function redactSecrets(report: RoutePlayReport, headerValues: string[]): RoutePlayReport {
  const secrets = [
    ...new Set(
      headerValues.filter(
        (value) => value.length > 0 && !["true", "false", "1", "0"].includes(value.toLowerCase()),
      ),
    ),
  ].sort((left, right) => right.length - left.length);
  return redactUnknown(report, secrets) as RoutePlayReport;
}

function summaryFor(
  results: RoutePlayReport["results"],
  failOn: RoutePlayConfig["failOn"],
): RunSummary {
  let errors = 0;
  let warnings = 0;
  let info = 0;
  let failed = 0;
  let incomplete = 0;
  for (const result of results) {
    if (!result.complete) incomplete += 1;
    for (const finding of result.findings) {
      if (finding.severity === "error") errors += 1;
      else if (finding.severity === "warning") warnings += 1;
      else info += 1;
    }
    const violates = result.findings.some((finding) => severityFails(finding.severity, failOn));
    if (!result.complete || violates) failed += 1;
  }
  return {
    transitions: results.length,
    passed: results.length - failed,
    failed,
    incomplete,
    errors,
    warnings,
    info,
  };
}

export function severityFails(severity: Severity, failOn: RoutePlayConfig["failOn"]): boolean {
  if (failOn === "never") return false;
  if (failOn === "warning") return severity === "warning" || severity === "error";
  return severity === "error";
}

export async function runRoutePlay(
  config: RoutePlayConfig,
  providedBrowser?: Browser,
): Promise<RoutePlayReport> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const browser = providedBrowser ?? (await launchBrowser());
  try {
    const results = [];
    for (const transition of config.transitions) {
      results.push(await runTransition(browser, transition, config));
    }
    const summary = summaryFor(results, config.failOn);
    const finished = Date.now();
    const report: RoutePlayReport = {
      schemaVersion: 1,
      tool: { name: "routeplay", version: VERSION },
      startedAt,
      finishedAt: new Date(finished).toISOString(),
      durationMs: finished - started,
      baseUrl: config.baseUrl,
      environment: {
        browser: "chromium",
        locale: config.browser.locale,
        timezoneId: config.browser.timezoneId,
        viewport: config.browser.viewport,
      },
      policy: { failOn: config.failOn },
      results,
      summary,
      passed: summary.failed === 0,
    };
    return redactSecrets(report, Object.values(config.headers));
  } finally {
    if (!providedBrowser) await browser.close();
  }
}
