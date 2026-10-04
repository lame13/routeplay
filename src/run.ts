import type { Browser } from "playwright";
import { baselineFindings, hreflangReciprocityFindings } from "./analyze.js";
import { transitionSlug, writeTransitionArtifacts } from "./artifacts.js";
import { readStorageState } from "./auth.js";
import { transitionSpecHash } from "./baseline.js";
import { launchBrowser, runTransition, type TransitionOutcome } from "./browser.js";
import { activeFindings, failsPolicy, severityFails } from "./policy.js";
import { configSecretValues, redactSecrets, redactUnknown } from "./redact.js";
import { applySuppressions, expiredSuppressionFinding, todayIso } from "./suppress.js";
import type {
  Finding,
  Phase,
  RoutePlayConfig,
  RoutePlayReport,
  RunSummary,
  SemanticSnapshot,
  TransitionResult,
  TransitionSpec,
} from "./types.js";
import { VERSION } from "./version.js";

export { redactSecrets } from "./redact.js";
export { severityFails, VERSION };

function summaryFor(
  results: RoutePlayReport["results"],
  failOn: RoutePlayConfig["failOn"],
): RunSummary {
  let errors = 0;
  let warnings = 0;
  let info = 0;
  let suppressed = 0;
  let failed = 0;
  let incomplete = 0;
  for (const result of results) {
    if (!result.complete) incomplete += 1;
    for (const finding of result.findings) {
      if (finding.suppressed === true) {
        suppressed += 1;
        continue;
      }
      if (finding.severity === "error") errors += 1;
      else if (finding.severity === "warning") warnings += 1;
      else info += 1;
    }
    if (!result.complete || failsPolicy(result.findings, failOn)) failed += 1;
  }
  return {
    transitions: results.length,
    passed: results.length - failed,
    failed,
    incomplete,
    errors,
    warnings,
    info,
    suppressed,
  };
}

interface RepeatField {
  label: string;
  select: (snapshot: SemanticSnapshot) => unknown;
}

const repeatFields: RepeatField[] = [
  { label: "Final route URL", select: (snapshot) => snapshot.url },
  { label: "Document language", select: (snapshot) => snapshot.lang },
  {
    label: "Hreflang alternates",
    select: (snapshot) => snapshot.hreflangs.map((entry) => `${entry.hreflang} ${entry.href}`),
  },
  { label: "Title", select: (snapshot) => snapshot.titles },
  { label: "Meta description", select: (snapshot) => snapshot.descriptions },
  { label: "Canonical URL", select: (snapshot) => snapshot.canonicals },
  { label: "Robots directives", select: (snapshot) => snapshot.robots },
  { label: "H1", select: (snapshot) => snapshot.h1 },
  { label: "JSON-LD blocks", select: (snapshot) => snapshot.jsonLdFingerprints },
  { label: "Main-content hash", select: (snapshot) => snapshot.main.hash },
  { label: "Crawlable internal links", select: (snapshot) => snapshot.links },
];

function sample(value: string): string {
  return value.length > 200 ? `${value.slice(0, 197)}...` : value;
}

/**
 * Repeated captures exist to separate a real regression from an unstable route: a field that
 * changes between identical requests cannot be trusted in any parity or baseline verdict.
 */
function unstableFieldFindings(captures: Array<Record<Phase, SemanticSnapshot>>): Finding[] {
  if (captures.length < 2) return [];
  const findings: Finding[] = [];
  const phases: Phase[] = ["server", "cold", "transition"];
  for (const phase of phases) {
    for (const field of repeatFields) {
      const values = [
        ...new Set(captures.map((capture) => JSON.stringify(field.select(capture[phase])))),
      ];
      if (values.length < 2) continue;
      findings.push({
        ruleId: "RP601",
        severity: "warning",
        phase,
        message: `${field.label} changed between repeated captures of ${phase === "server" ? "the server response" : phase === "cold" ? "the cold load" : "in-app navigation"}.`,
        actual: { samples: values.slice(0, 3).map(sample) },
        hint: "Make the route deterministic, or ignore the dynamic region, before trusting parity results.",
      });
    }
  }
  return findings;
}

async function repeatFindings(
  browser: Browser,
  spec: TransitionSpec,
  config: RoutePlayConfig,
  primary: Record<Phase, SemanticSnapshot>,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const captures = [primary];
  for (let index = 1; index < config.repeat; index += 1) {
    const outcome = await runTransition(browser, spec, config);
    const captured = outcome.result.captures;
    if (!outcome.result.complete || !captured) {
      findings.push({
        ruleId: "RP602",
        severity: "warning",
        message: `Repeated capture ${index + 1} of ${config.repeat} did not complete.`,
        actual: activeFindings(outcome.result.findings)
          .map((finding) => finding.message)
          .slice(0, 3),
        hint: "An intermittent route cannot be compared reliably.",
      });
      continue;
    }
    captures.push({
      server: captured.server.semantic,
      cold: captured.cold.semantic,
      transition: captured.transition.semantic,
    });
  }
  findings.push(...unstableFieldFindings(captures));
  return findings;
}

async function augmentOutcome(
  browser: Browser,
  spec: TransitionSpec,
  config: RoutePlayConfig,
  outcome: TransitionOutcome,
): Promise<TransitionOutcome> {
  const result: TransitionResult = { ...outcome.result };
  const extra: Finding[] = [];
  if (result.complete && result.captures) {
    if (config.repeat > 1) {
      extra.push(
        ...(await repeatFindings(browser, spec, config, {
          server: result.captures.server.semantic,
          cold: result.captures.cold.semantic,
          transition: result.captures.transition.semantic,
        })),
      );
    }
    if (config.baseline) {
      extra.push(
        ...baselineFindings(
          spec,
          transitionSpecHash(config, spec),
          config.baseline,
          redactUnknown(result.captures, configSecretValues(config)) as NonNullable<
            TransitionResult["captures"]
          >,
          config.compare,
        ),
      );
    }
  }
  const suppression = applySuppressions(
    [...result.findings, ...extra],
    config.ignore,
    spec.name,
    todayIso(),
  );
  // Expired suppressions are reported after suppression so they can never hide themselves.
  result.findings = [
    ...suppression.findings,
    ...suppression.expired.map((rule) => expiredSuppressionFinding(rule)),
  ];
  return { ...outcome, result };
}

async function runWithRetries(
  browser: Browser,
  spec: TransitionSpec,
  config: RoutePlayConfig,
): Promise<TransitionOutcome> {
  const started = Date.now();
  const attemptsAllowed = config.retries + 1;
  let attempts = 0;
  let outcome: TransitionOutcome | undefined;
  let failed = true;

  while (attempts < attemptsAllowed) {
    attempts += 1;
    outcome = await augmentOutcome(
      browser,
      spec,
      config,
      await runTransition(browser, spec, config),
    );
    failed = !outcome.result.complete || failsPolicy(outcome.result.findings, config.failOn);
    if (!failed) break;
  }
  if (!outcome) throw new Error(`${spec.name}: no capture attempt was made.`);

  const result: TransitionResult = { ...outcome.result, attempts };
  result.durationMs = Date.now() - started;
  return { ...outcome, result };
}

/**
 * Hreflang reciprocity is a run-level check: it only means something when the config covers both
 * ends of an alternate link.
 */
function applyHreflangReciprocity(results: TransitionResult[], config: RoutePlayConfig): void {
  const routes: Array<{ index: number; to: string; hreflangs: SemanticSnapshot["hreflangs"] }> = [];
  for (const [index, result] of results.entries()) {
    const server = result.captures?.server.semantic;
    if (!result.complete || !server) continue;
    routes.push({ index, to: server.url, hreflangs: server.hreflangs });
  }
  const findings = hreflangReciprocityFindings(
    routes.map((route) => ({ to: route.to, hreflangs: route.hreflangs })),
  );
  findings.forEach((list, position) => {
    const route = routes[position];
    if (!route || list.length === 0) return;
    const target = results[route.index];
    if (!target) return;
    const suppression = applySuppressions(list, config.ignore, target.name, todayIso());
    target.findings = [
      ...target.findings,
      ...suppression.findings,
      ...suppression.expired.map((rule) => expiredSuppressionFinding(rule)),
    ];
  });
}

export async function runRoutePlay(
  config: RoutePlayConfig,
  providedBrowser?: Browser,
): Promise<RoutePlayReport> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  if (config.browser.storageState) {
    config = { ...config, storageStateData: await readStorageState(config.browser.storageState) };
  }
  const workerCount = Math.max(1, Math.min(config.concurrency, config.transitions.length));
  const browser = providedBrowser ?? (await launchBrowser());
  try {
    const outcomes = new Array<TransitionOutcome>(config.transitions.length);
    let cursor = 0;
    let stopped = false;
    const workers = Array.from({ length: workerCount }, async () => {
      try {
        while (!stopped) {
          const index = cursor;
          cursor += 1;
          const spec = config.transitions[index];
          if (!spec) return;
          outcomes[index] = await runWithRetries(browser, spec, config);
        }
      } catch (error) {
        stopped = true;
        throw error;
      }
    });
    const settled = await Promise.allSettled(workers);
    for (const worker of settled) {
      if (worker.status === "rejected") throw worker.reason;
    }
    const results = outcomes.map((outcome) => outcome.result);
    applyHreflangReciprocity(results, config);
    if (config.artifacts) {
      for (const [index, outcome] of outcomes.entries()) {
        const result = outcome.result;
        if (result.complete && !failsPolicy(result.findings, config.failOn)) continue;
        const startedWriting = Date.now();
        const written = await writeTransitionArtifacts(
          config.artifacts,
          transitionSlug(index, result.name),
          outcome.artifacts,
          configSecretValues(config),
        );
        if (Object.keys(written).length > 0) result.artifacts = written;
        result.durationMs += Date.now() - startedWriting;
      }
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
      run: { concurrency: workerCount, retries: config.retries, repeat: config.repeat },
      ...(config.scope
        ? {
            scope: {
              diffBase: config.scope.diffBase,
              changedFiles: config.scope.changedFiles,
              skipped: config.scope.skipped.length,
            },
          }
        : {}),
      results,
      summary,
      passed: summary.failed === 0,
    };
    return redactSecrets(report, configSecretValues(config));
  } finally {
    if (!providedBrowser) await browser.close();
  }
}
