import { describe, expect, it } from "vitest";
import { htmlReport } from "../src/reporters/html.js";
import { jsonReport } from "../src/reporters/json.js";
import { sarifReport } from "../src/reporters/sarif.js";
import type { RoutePlayReport } from "../src/types.js";

const report: RoutePlayReport = {
  schemaVersion: 1,
  tool: { name: "routeplay", version: "0.1.0" },
  startedAt: "2026-08-21T00:00:00.000Z",
  finishedAt: "2026-08-21T00:00:01.000Z",
  durationMs: 1000,
  baseUrl: "https://example.test/",
  environment: {
    browser: "chromium",
    locale: "en-US",
    timezoneId: "UTC",
    viewport: { width: 1440, height: 900 },
  },
  policy: { failOn: "error" },
  results: [
    {
      name: "Unsafe <script>alert(1)</script>",
      from: "https://example.test/",
      to: "https://example.test/page/",
      navigation: { mode: "client" },
      findings: [
        {
          ruleId: "RP104",
          severity: "error",
          comparison: "cold-transition",
          message: "Canonical differs <img src=x onerror=alert(1)>",
        },
      ],
      durationMs: 1000,
      complete: true,
    },
  ],
  summary: { transitions: 1, passed: 0, failed: 1, incomplete: 0, errors: 1, warnings: 0, info: 0 },
  passed: false,
};

describe("reporters", () => {
  it("escapes all target-controlled HTML", () => {
    const html = htmlReport(report);
    expect(html).toContain("Unsafe &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<img src=x");
  });

  it("emits valid schema-versioned JSON", () => {
    const parsed = JSON.parse(jsonReport(report)) as { schemaVersion: number };
    expect(parsed.schemaVersion).toBe(1);
  });

  it("emits SARIF 2.1 with stable rules", () => {
    const parsed = JSON.parse(sarifReport(report)) as {
      version: string;
      runs: Array<{ results: Array<{ ruleId: string }> }>;
    };
    expect(parsed.version).toBe("2.1.0");
    expect(parsed.runs[0]?.results[0]?.ruleId).toBe("RP104");
  });
});
