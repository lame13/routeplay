import pc from "picocolors";
import { severityFails } from "../run.js";
import type { Finding, RoutePlayReport } from "../types.js";

function mark(finding: Finding): string {
  if (finding.severity === "error") return pc.red("ERROR");
  if (finding.severity === "warning") return pc.yellow("WARN ");
  return pc.cyan("INFO ");
}

function value(value: unknown): string {
  const rendered = typeof value === "string" ? value : JSON.stringify(value);
  return rendered.length > 240 ? `${rendered.slice(0, 237)}...` : rendered;
}

export function terminalReport(report: RoutePlayReport): string {
  const lines: string[] = [];
  lines.push(pc.bold(`RoutePlay ${report.tool.version}`));
  lines.push(
    `${report.summary.transitions} transition(s) · ${(report.durationMs / 1000).toFixed(1)}s`,
  );
  lines.push("");
  for (const result of report.results) {
    const failed =
      !result.complete ||
      result.findings.some((finding) => severityFails(finding.severity, report.policy.failOn));
    lines.push(`${failed ? pc.red("✗") : pc.green("✓")} ${pc.bold(result.name)}`);
    lines.push(`  ${result.from} → ${result.to} · ${result.navigation.mode}`);
    for (const finding of result.findings) {
      if (finding.severity === "info" && finding.ruleId === "RP004") continue;
      lines.push(`  ${mark(finding)} ${finding.ruleId} ${finding.message}`);
      if (finding.expected !== undefined)
        lines.push(`        expected: ${value(finding.expected)}`);
      if (finding.actual !== undefined) lines.push(`        actual:   ${value(finding.actual)}`);
      if (finding.hint) lines.push(`        hint:     ${finding.hint}`);
    }
    lines.push("");
  }
  const summary = `${report.summary.passed} passed · ${report.summary.failed} failed · ${report.summary.incomplete} incomplete · ${report.summary.errors} errors · ${report.summary.warnings} warnings`;
  lines.push(report.passed ? pc.green(pc.bold(summary)) : pc.red(pc.bold(summary)));
  return lines.join("\n");
}
