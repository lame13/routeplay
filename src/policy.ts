import type { RoutePlayConfig, Severity } from "./types.js";

export function severityFails(severity: Severity, failOn: RoutePlayConfig["failOn"]): boolean {
  if (failOn === "never") return false;
  if (failOn === "warning") return severity === "warning" || severity === "error";
  return severity === "error";
}
