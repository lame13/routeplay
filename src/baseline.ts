import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { readStorageState } from "./auth.js";
import { configSecretValues, redactUnknown } from "./redact.js";
import { hashText } from "./similarity.js";
import type {
  BaselineEntry,
  BaselineFile,
  RoutePlayConfig,
  RoutePlayReport,
  TransitionResult,
  TransitionSpec,
} from "./types.js";
import { VERSION } from "./version.js";

export const BASELINE_SCHEMA_VERSION = 1;
export const DEFAULT_BASELINE_PATH = "routeplay.baseline.json";

const hreflangSchema = z.object({ hreflang: z.string(), href: z.string() }).strict();

const snapshotSchema = z
  .object({
    url: z.string(),
    lang: z.string().default(""),
    hreflangs: z.array(hreflangSchema).default([]),
    titles: z.array(z.string()),
    descriptions: z.array(z.string()),
    canonicals: z.array(z.string()),
    robots: z.record(z.string(), z.array(z.string())),
    h1: z.array(z.string()),
    jsonLdTypes: z.array(z.string()),
    jsonLdFingerprints: z.array(z.string()),
    invalidJsonLd: z.number(),
    main: z
      .object({
        selector: z.string(),
        text: z.string(),
        hash: z.string(),
        length: z.number(),
      })
      .strict(),
    links: z.array(z.string()),
    linkLikeWithoutHref: z.number(),
  })
  .strict();

const baselineSchema = z
  .object({
    schemaVersion: z.literal(BASELINE_SCHEMA_VERSION),
    tool: z.object({ name: z.literal("routeplay"), version: z.string() }).strict(),
    baseUrl: z.string(),
    recordedAt: z.string(),
    transitions: z.array(
      z
        .object({
          name: z.string(),
          from: z.string(),
          to: z.string(),
          specHash: z.string(),
          recordedAt: z.string(),
          phases: z
            .object({
              server: snapshotSchema,
              cold: snapshotSchema,
              transition: snapshotSchema,
            })
            .strict(),
        })
        .strict(),
    ),
  })
  .strict()
  .refine(
    (baseline) =>
      new Set(baseline.transitions.map((entry) => entry.name)).size === baseline.transitions.length,
    {
      message: "Baseline transition names must be unique.",
    },
  );

/**
 * A baseline entry is only reusable while the settings that shape a capture stay the same.
 * Contract expectations and severity policy are deliberately excluded: they change the verdict,
 * not the observed behavior.
 */
export function transitionSpecHash(config: RoutePlayConfig, spec: TransitionSpec): string {
  return hashText(
    JSON.stringify({
      from: spec.from,
      to: spec.to,
      selector: spec.selector ?? "",
      readySelector: spec.readySelector ?? "",
      expectedFinalUrl: spec.expectedFinalUrl,
      mainSelector: spec.mainSelector ?? "",
      ignoreSelectors: spec.ignoreSelectors,
      locale: config.browser.locale,
      timezoneId: config.browser.timezoneId,
      userAgent: config.browser.userAgent ?? "",
      viewport: config.browser.viewport,
      timeoutMs: config.browser.timeoutMs,
      settleMs: config.browser.settleMs,
      compareLinks: config.compare.compareLinks,
    }),
  );
}

function findSpec(config: RoutePlayConfig, result: TransitionResult): TransitionSpec | undefined {
  return (
    config.transitions.find(
      (transition) => transition.name === result.name && transition.to === result.to,
    ) ??
    config.transitions.find(
      (transition) => transition.name === result.name || transition.to === result.to,
    )
  );
}

export function baselineFromReport(
  report: RoutePlayReport,
  config: RoutePlayConfig,
): { baseline: BaselineFile; skipped: string[] } {
  const recordedAt = new Date().toISOString();
  const entries: BaselineEntry[] = [];
  const skipped: string[] = [];
  for (const result of report.results) {
    const spec = findSpec(config, result);
    const captures = result.captures;
    if (!spec || !captures || !result.complete) {
      skipped.push(result.name);
      continue;
    }
    entries.push({
      name: result.name,
      from: result.from,
      to: result.to,
      specHash: transitionSpecHash(config, spec),
      recordedAt,
      phases: {
        server: captures.server.semantic,
        cold: captures.cold.semantic,
        transition: captures.transition.semantic,
      },
    });
  }
  return {
    baseline: {
      schemaVersion: BASELINE_SCHEMA_VERSION,
      tool: { name: "routeplay", version: VERSION },
      baseUrl: config.baseUrl,
      recordedAt,
      transitions: entries,
    },
    skipped,
  };
}

export function baselineEntryFor(
  baseline: BaselineFile,
  spec: TransitionSpec,
): BaselineEntry | undefined {
  return (
    baseline.transitions.find((entry) => entry.name === spec.name) ??
    baseline.transitions.find((entry) => entry.from === spec.from && entry.to === spec.to)
  );
}

/**
 * Re-recording a subset of transitions must not discard the entries that were not re-run.
 */
export function mergeBaseline(
  existing: BaselineFile | undefined,
  fresh: BaselineFile,
): { baseline: BaselineFile; replaced: number; added: number; retained: number } {
  if (!existing) {
    return { baseline: fresh, replaced: 0, added: fresh.transitions.length, retained: 0 };
  }
  const recorded = new Map(fresh.transitions.map((entry) => [entry.name, entry]));
  let replaced = 0;
  const retained = existing.transitions.filter((entry) => {
    if (!recorded.has(entry.name)) return true;
    replaced += 1;
    return false;
  });
  const added = fresh.transitions.length - replaced;
  return {
    baseline: {
      ...fresh,
      transitions: [...retained, ...fresh.transitions].sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
    },
    replaced,
    added,
    retained: retained.length,
  };
}

export async function readBaselineIfPresent(file: string): Promise<BaselineFile | undefined> {
  try {
    return await loadBaseline(file);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
    )
      return undefined;
    throw error;
  }
}

export async function loadBaseline(file: string): Promise<BaselineFile> {
  const absolute = path.resolve(file);
  let contents: string;
  try {
    contents = await readFile(absolute, "utf8");
  } catch (error) {
    throw new Error(
      `Could not read baseline at ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `Invalid JSON in baseline ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = baselineSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "baseline"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid RoutePlay baseline at ${absolute}:\n${detail}`);
  }
  return result.data;
}

export async function writeBaseline(
  file: string,
  baseline: BaselineFile,
  config: RoutePlayConfig,
): Promise<string> {
  const absolute = path.resolve(file);
  const storageStateData =
    config.storageStateData ??
    (config.browser.storageState ? await readStorageState(config.browser.storageState) : undefined);
  const redacted = redactUnknown(baseline, configSecretValues({ ...config, storageStateData }));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(redacted, null, 2)}\n`, "utf8");
  return absolute;
}
