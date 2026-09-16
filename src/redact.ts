import type { RoutePlayReport } from "./types.js";

export function secretValues(headerValues: string[]): string[] {
  return [
    ...new Set(
      headerValues.filter(
        (value) => value.length > 0 && !["true", "false", "1", "0"].includes(value.toLowerCase()),
      ),
    ),
  ].sort((left, right) => right.length - left.length);
}

export function redactText(value: string, secrets: string[]): string {
  const variants = secrets.flatMap((secret) => {
    const htmlText = secret
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
    return [secret, encodeURIComponent(secret), htmlText, htmlText.replaceAll('"', "&quot;")];
  });
  return [...new Set(variants)]
    .sort((left, right) => right.length - left.length)
    .reduce((current, secret) => current.replaceAll(secret, "[REDACTED]"), value);
}

export function redactUnknown(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, secrets));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, redactUnknown(nested, secrets)]),
  );
}

export function redactSecrets(report: RoutePlayReport, headerValues: string[]): RoutePlayReport {
  return redactUnknown(report, secretValues(headerValues)) as RoutePlayReport;
}
