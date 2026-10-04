import type { Finding, RoutePlayConfig, Severity } from "./types.js";

export function severityFails(severity: Severity, failOn: RoutePlayConfig["failOn"]): boolean {
  if (failOn === "never") return false;
  if (failOn === "warning") return severity === "warning" || severity === "error";
  return severity === "error";
}

/** Suppressed findings stay in the report as evidence but never fail a run. */
export function activeFindings(findings: Finding[]): Finding[] {
  return findings.filter((finding) => finding.suppressed !== true);
}

export function failsPolicy(findings: Finding[], failOn: RoutePlayConfig["failOn"]): boolean {
  return activeFindings(findings).some((finding) => severityFails(finding.severity, failOn));
}
