import type { RoutePlayReport } from "../types.js";

export function jsonReport(report: RoutePlayReport): string {
  return JSON.stringify(
    report,
    (key, value: unknown) => {
      if (key === "text" && typeof value === "string") {
        return value.length > 300 ? `${value.slice(0, 297)}...` : value;
      }
      return value;
    },
    2,
  );
}
