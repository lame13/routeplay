import type { Finding, IgnoreRule } from "./types.js";

export interface SuppressionOutcome {
  findings: Finding[];
  suppressed: number;
  expired: IgnoreRule[];
}

function matchesRule(rule: IgnoreRule, finding: Finding): boolean {
  return rule.ruleId === "*" || rule.ruleId === finding.ruleId;
}

function isExpired(rule: IgnoreRule, today: string): boolean {
  return rule.until !== undefined && rule.until < today;
}

export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Marks findings covered by an active `ignore` rule. Expired rules stop hiding anything and are
 * returned so the caller can report that the promise attached to them has lapsed.
 */
export function applySuppressions(
  findings: Finding[],
  rules: IgnoreRule[],
  transitionName: string,
  today: string,
): SuppressionOutcome {
  const applicable = rules.filter(
    (rule) => rule.transition === undefined || rule.transition === transitionName,
  );
  const active = applicable.filter((rule) => !isExpired(rule, today));
  // An expired suppression only matters where it would have hidden something.
  const expired = applicable.filter(
    (rule) => isExpired(rule, today) && findings.some((finding) => matchesRule(rule, finding)),
  );
  let suppressed = 0;
  const updated = findings.map((finding) => {
    const rule = active.find((candidate) => matchesRule(candidate, finding));
    if (!rule) return finding;
    suppressed += 1;
    return { ...finding, suppressed: true, suppressedReason: rule.reason };
  });
  return { findings: updated, suppressed, expired };
}

export function expiredSuppressionFinding(rule: IgnoreRule): Finding {
  return {
    ruleId: "RP006",
    severity: "warning",
    message: `A suppression for ${rule.ruleId} expired${rule.until ? ` on ${rule.until}` : ""}; matching findings are reported again.`,
    expected: rule.ruleId,
    actual: { reason: rule.reason, ...(rule.until ? { until: rule.until } : {}) },
    hint: "Fix the underlying finding, or extend the suppression deliberately.",
  };
}
