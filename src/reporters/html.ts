import { severityFails } from "../run.js";
import type { Finding, RoutePlayReport } from "../types.js";

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function evidence(finding: Finding): string {
  const parts: string[] = [];
  if (finding.expected !== undefined)
    parts.push(
      `<div><b>Expected:</b> <code>${escapeHtml(JSON.stringify(finding.expected))}</code></div>`,
    );
  if (finding.actual !== undefined)
    parts.push(
      `<div><b>Actual:</b> <code>${escapeHtml(JSON.stringify(finding.actual))}</code></div>`,
    );
  if (finding.hint) parts.push(`<div class="hint">${escapeHtml(finding.hint)}</div>`);
  return parts.join("");
}

export function htmlReport(report: RoutePlayReport): string {
  const cards = report.results
    .map((result) => {
      const findings = result.findings
        .filter((finding) => !(finding.severity === "info" && finding.ruleId === "RP004"))
        .map(
          (finding) => `<li class="finding ${finding.severity}">
            <div><span class="badge">${escapeHtml(finding.severity)}</span> <b>${escapeHtml(finding.ruleId)}</b> ${escapeHtml(finding.message)}</div>
            ${evidence(finding)}
          </li>`,
        )
        .join("");
      const captures = result.captures;
      const metrics = captures
        ? `<div class="metrics">
            <span>Source text <b>${captures.server.semantic.main.length}</b></span>
            <span>Cold text <b>${captures.cold.semantic.main.length}</b></span>
            <span>Transition text <b>${captures.transition.semantic.main.length}</b></span>
            <span>Source links <b>${captures.server.semantic.links.length}</b></span>
            <span>Cold links <b>${captures.cold.semantic.links.length}</b></span>
            <span>Transition links <b>${captures.transition.semantic.links.length}</b></span>
          </div>`
        : "";
      const passed =
        result.complete &&
        !result.findings.some((finding) => severityFails(finding.severity, report.policy.failOn));
      return `<section class="card">
        <header><div><h2>${escapeHtml(result.name)}</h2><div class="route">${escapeHtml(result.from)} → ${escapeHtml(result.to)}</div></div>
          <span class="result ${passed ? "pass" : "fail"}">${result.complete ? (passed ? "pass" : "fail") : "incomplete"}</span></header>
        <div class="mode">Navigation: <b>${escapeHtml(result.navigation.mode)}</b> · ${(result.durationMs / 1000).toFixed(1)}s</div>
        ${metrics}<ul>${findings || "<li class='empty'>No reportable differences.</li>"}</ul>
      </section>`;
    })
    .join("\n");
  const status = report.passed ? "Passed" : "Failed";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RoutePlay report · ${status}</title>
<style>
:root{color-scheme:light;--bg:#f5f7fb;--ink:#172033;--muted:#647089;--line:#dce2ec;--red:#be123c;--amber:#a16207;--green:#15803d;--blue:#2563eb}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{max-width:1040px;margin:0 auto;padding:48px 24px}h1,h2{line-height:1.15;margin:0}.lead{display:flex;justify-content:space-between;gap:24px;align-items:end;margin-bottom:28px}.summary{color:var(--muted);margin-top:8px}.overall{font-weight:800;font-size:20px;color:${report.passed ? "var(--green)" : "var(--red)"}}.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:22px;margin:16px 0;box-shadow:0 5px 18px rgba(24,35,57,.05)}.card header{display:flex;justify-content:space-between;gap:16px}.route,.mode{color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;margin-top:7px}.result,.badge{border-radius:999px;padding:3px 9px;text-transform:uppercase;font-size:11px;font-weight:800;letter-spacing:.04em}.result.pass{background:#dcfce7;color:var(--green)}.result.fail{background:#ffe4e6;color:var(--red)}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin:18px 0}.metrics span{background:#f7f9fc;border:1px solid #e7ebf2;border-radius:8px;padding:8px 10px;color:var(--muted)}ul{padding:0;margin:18px 0 0;list-style:none}.finding{padding:14px 0;border-top:1px solid var(--line)}.finding:first-child{border-top:0}.finding.error .badge{background:#ffe4e6;color:var(--red)}.finding.warning .badge{background:#fef3c7;color:var(--amber)}.finding.info .badge{background:#dbeafe;color:var(--blue)}code{white-space:pre-wrap;overflow-wrap:anywhere}.hint{color:var(--muted);margin-top:4px}.empty{color:var(--green)}footer{color:var(--muted);margin-top:30px;font-size:13px}a{color:var(--blue)}</style></head>
<body><main class="wrap"><div class="lead"><div><h1>RoutePlay ${escapeHtml(report.tool.version)}</h1><div class="summary">${report.summary.transitions} transitions · ${report.summary.errors} errors · ${report.summary.warnings} warnings · ${(report.durationMs / 1000).toFixed(1)}s</div></div><div class="overall">${status}</div></div>${cards}<footer>Generated ${escapeHtml(report.finishedAt)} · <a href="https://nikom.work">nikom.work</a></footer></main></body></html>`;
}
