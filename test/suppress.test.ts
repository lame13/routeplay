import { describe, expect, it } from "vitest";
import { applySuppressions, expiredSuppressionFinding, todayIso } from "../src/suppress.js";
import type { Finding, IgnoreRule } from "../src/types.js";

const findings: Finding[] = [
  { ruleId: "RP104", severity: "error", message: "Canonical differs." },
  { ruleId: "RP108", severity: "error", message: "Links differ." },
];

describe("applySuppressions", () => {
  it("marks only the matching rule as suppressed", () => {
    const rules: IgnoreRule[] = [{ ruleId: "RP104", reason: "Tracked in SEO-142" }];
    const outcome = applySuppressions(findings, rules, "Home to pricing", "2026-10-04");
    expect(outcome.suppressed).toBe(1);
    expect(outcome.findings[0]).toMatchObject({
      ruleId: "RP104",
      suppressed: true,
      suppressedReason: "Tracked in SEO-142",
    });
    expect(outcome.findings[1]?.suppressed).toBeUndefined();
  });

  it("supports a wildcard and transition-scoped rules", () => {
    const rules: IgnoreRule[] = [
      { ruleId: "*", reason: "Known gap", transition: "Home to pricing" },
    ];
    expect(applySuppressions(findings, rules, "Home to pricing", "2026-10-04").suppressed).toBe(2);
    expect(applySuppressions(findings, rules, "Other", "2026-10-04").suppressed).toBe(0);
  });

  it("stops hiding findings once a suppression expires", () => {
    const rule: IgnoreRule = {
      ruleId: "RP104",
      reason: "Until the redesign ships",
      until: "2026-01-01",
    };
    const rules: IgnoreRule[] = [rule];
    const outcome = applySuppressions(findings, rules, "Home to pricing", "2026-10-04");
    expect(outcome.suppressed).toBe(0);
    expect(outcome.findings.every((finding) => finding.suppressed === undefined)).toBe(true);
    expect(outcome.expired).toEqual(rules);
    expect(expiredSuppressionFinding(rule)).toMatchObject({
      ruleId: "RP006",
      severity: "warning",
    });
  });

  it("keeps a suppression active through its own expiry date", () => {
    const rules: IgnoreRule[] = [{ ruleId: "RP104", reason: "Same day", until: "2026-10-04" }];
    expect(applySuppressions(findings, rules, "Any", "2026-10-04").suppressed).toBe(1);
    expect(applySuppressions(findings, rules, "Any", "2026-10-05").suppressed).toBe(0);
  });

  it("stays quiet about an expired suppression that would hide nothing", () => {
    const rules: IgnoreRule[] = [
      { ruleId: "RP503", reason: "Locale work", until: "2026-01-01" },
      { ruleId: "*", reason: "Everything, once", until: "2026-01-01" },
    ];
    const outcome = applySuppressions(findings, rules, "Any", "2026-10-04");
    // The wildcard still matches these findings, so the lapse is reported once through it.
    expect(outcome.expired).toEqual([rules[1]]);
  });
});

describe("todayIso", () => {
  it("formats a date the way suppressions store it", () => {
    expect(todayIso(new Date("2026-10-04T23:30:00.000Z"))).toBe("2026-10-04");
  });
});
