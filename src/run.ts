import { readFileSync } from "node:fs";
import type { Browser } from "playwright";
import { transitionSlug, writeTransitionArtifacts } from "./artifacts.js";
import { launchBrowser, runTransition, type TransitionOutcome } from "./browser.js";
import { severityFails } from "./policy.js";
import { redactSecrets, secretValues } from "./redact.js";
import type {
  RoutePlayConfig,
  RoutePlayReport,
  RunSummary,
  TransitionResult,
  TransitionSpec,
} from "./types.js";

export { redactSecrets } from "./redact.js";
export { severityFails };

function readPackageVersion(): string {
  const metadata = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as unknown;
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("version" in metadata) ||
    typeof metadata.version !== "string"
  ) {
    throw new Error("RoutePlay package metadata has no valid version.");
  }
  return metadata.version;
}

export const VERSION = readPackageVersion();

function summaryFor(
  results: RoutePlayReport["results"],
  failOn: RoutePlayConfig["failOn"],
): RunSummary {
  let errors = 0;
  let warnings = 0;
  let info = 0;
  let failed = 0;
  let incomplete = 0;
  for (const result of results) {
    if (!result.complete) incomplete += 1;
    for (const finding of result.findings) {
      if (finding.severity === "error") errors += 1;
      else if (finding.severity === "warning") warnings += 1;
      else info += 1;
    }
    const policyViolation = result.findings.some((finding) =>
      severityFails(finding.severity, failOn),
    );
    if (!result.complete || policyViolation) failed += 1;
  }
  return {
    transitions: results.length,
    passed: results.length - failed,
    failed,
    incomplete,
    errors,
    warnings,
    info,
  };
}

function failsPolicy(result: TransitionResult, failOn: RoutePlayConfig["failOn"]): boolean {
  return (
    !result.complete || result.findings.some((finding) => severityFails(finding.severity, failOn))
  );
}

interface ArtifactContext {
  slug: string;
  secrets: string[];
}

async function runWithRetries(
  browser: Browser,
  spec: TransitionSpec,
  config: RoutePlayConfig,
  artifactContext: ArtifactContext,
): Promise<TransitionResult> {
  const started = Date.now();
  const attemptsAllowed = config.retries + 1;
  let attempts = 0;
  let outcome: TransitionOutcome | undefined;
  let failed = true;

  while (attempts < attemptsAllowed) {
    attempts += 1;
    outcome = await runTransition(browser, spec, config);
    failed = failsPolicy(outcome.result, config.failOn);
    if (!failed) break;
  }
  if (!outcome) throw new Error(`${spec.name}: no capture attempt was made.`);

  const result: TransitionResult = { ...outcome.result, attempts };
  if (failed && config.artifacts) {
    const written = await writeTransitionArtifacts(
      config.artifacts,
      artifactContext.slug,
      outcome.artifacts,
      artifactContext.secrets,
    );
    if (Object.keys(written).length > 0) result.artifacts = written;
  }
  result.durationMs = Date.now() - started;
  return result;
}

export async function runRoutePlay(
  config: RoutePlayConfig,
  providedBrowser?: Browser,
): Promise<RoutePlayReport> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const secrets = secretValues(Object.values(config.headers));
  const workerCount = Math.max(1, Math.min(config.concurrency, config.transitions.length));
  const browser = providedBrowser ?? (await launchBrowser());
  try {
    const results = new Array<TransitionResult>(config.transitions.length);
    let cursor = 0;
    let stopped = false;
    const workers = Array.from({ length: workerCount }, async () => {
      try {
        while (!stopped) {
          const index = cursor;
          cursor += 1;
          const spec = config.transitions[index];
          if (!spec) return;
          results[index] = await runWithRetries(browser, spec, config, {
            slug: transitionSlug(index, spec.name),
            secrets,
          });
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
      run: { concurrency: workerCount, retries: config.retries },
      results,
      summary,
      passed: summary.failed === 0,
    };
    return redactSecrets(report, Object.values(config.headers));
  } finally {
    if (!providedBrowser) await browser.close();
  }
}
