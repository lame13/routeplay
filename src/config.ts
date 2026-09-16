import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { normalizeText } from "./similarity.js";
import type { CheckOptions, RouteExpectations, RoutePlayConfig } from "./types.js";

const expectedText = z.string().trim().min(1);

const routeExpectationsSchema = z
  .object({
    title: expectedText.optional(),
    description: expectedText.optional(),
    canonical: expectedText.optional(),
    h1: z.array(expectedText).min(1).optional(),
    robots: z
      .record(expectedText, z.array(expectedText).min(1))
      .refine((value) => Object.keys(value).length > 0, {
        message: "Add at least one robots user agent.",
      })
      .optional(),
    jsonLdTypesInclude: z.array(expectedText).min(1).optional(),
    mainTextIncludes: z.array(expectedText).min(1).optional(),
    linksInclude: z.array(expectedText).min(1).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Add at least one route expectation.",
  });

const transitionSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    from: z.string().trim().min(1),
    to: z.string().trim().min(1),
    expectedFinalUrl: z.string().trim().min(1).optional(),
    selector: z.string().trim().min(1).optional(),
    mainSelector: z.string().trim().min(1).optional(),
    ignoreSelectors: z.array(z.string().trim().min(1)).default([]),
    readySelector: z.string().trim().min(1).optional(),
    expectedStatus: z.number().int().min(100).max(599).default(200),
    requireClientNavigation: z.boolean().default(false),
    expect: routeExpectationsSchema.optional(),
  })
  .strict();

const httpUrl = z.url().refine((value) => /^https?:\/\//i.test(value), {
  message: "Only HTTP(S) URLs are supported.",
});

const configSchema = z
  .object({
    $schema: z.string().optional(),
    baseUrl: httpUrl,
    transitions: z.array(transitionSchema).min(1),
    browser: z
      .object({
        timeoutMs: z.number().int().min(1_000).max(120_000).default(20_000),
        settleMs: z.number().int().min(100).max(10_000).default(500),
        locale: z.string().min(2).default("en-US"),
        timezoneId: z.string().min(1).default("UTC"),
        userAgent: z.string().min(1).optional(),
        viewport: z
          .object({
            width: z.number().int().min(320).max(7680).default(1440),
            height: z.number().int().min(240).max(4320).default(900),
          })
          .strict()
          .default({ width: 1440, height: 900 }),
      })
      .strict()
      .default({
        timeoutMs: 20_000,
        settleMs: 500,
        locale: "en-US",
        timezoneId: "UTC",
        viewport: { width: 1440, height: 900 },
      }),
    compare: z
      .object({
        minTextSimilarity: z.number().min(0).max(1).default(0.98),
        minSourceTextLength: z.number().int().min(0).max(100_000).default(80),
        compareLinks: z.boolean().default(true),
      })
      .strict()
      .default({ minTextSimilarity: 0.98, minSourceTextLength: 80, compareLinks: true }),
    headers: z.record(z.string(), z.string()).default({}),
    failOn: z.enum(["error", "warning", "never"]).default("error"),
    concurrency: z.number().int().min(1).max(8).default(1),
    retries: z.number().int().min(0).max(3).default(0),
    artifacts: z.string().trim().min(1).optional(),
  })
  .strict();

function interpolateEnvironment(value: string, key: string): string {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_match, variable: string) => {
    const resolved = process.env[variable];
    if (resolved === undefined) {
      throw new Error(`Header ${key} references missing environment variable ${variable}.`);
    }
    return resolved;
  });
}

function parseHeader(raw: string): [string, string] {
  const separator = raw.indexOf("=");
  if (separator < 1) {
    throw new Error(`Invalid --header value "${raw}". Use NAME=VALUE.`);
  }
  return [raw.slice(0, separator).trim(), raw.slice(separator + 1)];
}

function integerOverride(
  value: number | undefined,
  minimum: number,
  maximum: number,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

export function normalizeUrl(baseUrl: string, value: string): string {
  const url = new URL(value, baseUrl);
  if (!/^https?:$/.test(url.protocol)) {
    throw new Error(`Only HTTP(S) URLs are supported: ${value}`);
  }
  return url.href;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeRobots(value: Record<string, string[]>): Record<string, string[]> {
  const normalized = new Map<string, string[]>();
  for (const [name, directives] of Object.entries(value)) {
    const key = normalizeText(name).toLocaleLowerCase();
    const current = normalized.get(key) ?? [];
    normalized.set(
      key,
      unique([
        ...current,
        ...directives.map((directive) => normalizeText(directive).toLocaleLowerCase()),
      ]).sort((left, right) => left.localeCompare(right)),
    );
  }
  return Object.fromEntries(
    [...normalized.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function normalizeRequiredLink(baseUrl: string, value: string): string {
  const url = new URL(normalizeUrl(baseUrl, value));
  url.hash = "";
  return url.href;
}

function normalizeExpectations(value: RouteExpectations, baseUrl: string): RouteExpectations {
  return {
    ...(value.title === undefined ? {} : { title: normalizeText(value.title) }),
    ...(value.description === undefined ? {} : { description: normalizeText(value.description) }),
    ...(value.canonical === undefined ? {} : { canonical: normalizeUrl(baseUrl, value.canonical) }),
    ...(value.h1 === undefined ? {} : { h1: value.h1.map((heading) => normalizeText(heading)) }),
    ...(value.robots === undefined ? {} : { robots: normalizeRobots(value.robots) }),
    ...(value.jsonLdTypesInclude === undefined
      ? {}
      : {
          jsonLdTypesInclude: unique(value.jsonLdTypesInclude.map((type) => normalizeText(type))),
        }),
    ...(value.mainTextIncludes === undefined
      ? {}
      : {
          mainTextIncludes: unique(
            value.mainTextIncludes.map((fragment) => normalizeText(fragment)),
          ),
        }),
    ...(value.linksInclude === undefined
      ? {}
      : {
          linksInclude: unique(
            value.linksInclude.map((link) => normalizeRequiredLink(baseUrl, link)),
          ),
        }),
  };
}

export async function loadConfig(options: CheckOptions): Promise<RoutePlayConfig> {
  let input: unknown;
  if (options.configPath) {
    const absolute = path.resolve(options.configPath);
    let contents: string;
    try {
      contents = await readFile(absolute, "utf8");
    } catch (error) {
      throw new Error(
        `Could not read config at ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      input = JSON.parse(contents);
    } catch (error) {
      throw new Error(
        `Invalid JSON in ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    if (!options.baseUrl || !options.from || !options.to) {
      throw new Error("Use --config, or provide --base-url, --from, and --to together.");
    }
    input = {
      baseUrl: options.baseUrl,
      transitions: [{ from: options.from, to: options.to, selector: options.selector }],
    };
  }

  const parsed = configSchema.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid RoutePlay config:\n${detail}`);
  }

  const cliHeaders = Object.fromEntries((options.headers ?? []).map(parseHeader));
  const headers = Object.fromEntries(
    Object.entries({ ...parsed.data.headers, ...cliHeaders }).map(([key, value]) => [
      key,
      interpolateEnvironment(value, key),
    ]),
  );
  const baseUrl = new URL(options.baseUrl ?? parsed.data.baseUrl).href;
  const concurrency =
    integerOverride(options.concurrency, 1, 8, "Concurrency") ?? parsed.data.concurrency;
  const retries = integerOverride(options.retries, 0, 3, "Retries") ?? parsed.data.retries;
  const artifacts = options.artifacts?.trim() ?? parsed.data.artifacts;
  if (artifacts === "") throw new Error("Artifacts directory must not be empty.");
  const transitions = parsed.data.transitions.map((transition, index) => ({
    ...transition,
    name: transition.name ?? `Transition ${index + 1}`,
    from: normalizeUrl(baseUrl, transition.from),
    to: normalizeUrl(baseUrl, transition.to),
    expectedFinalUrl: normalizeUrl(baseUrl, transition.expectedFinalUrl ?? transition.to),
    ...(transition.expect ? { expect: normalizeExpectations(transition.expect, baseUrl) } : {}),
  }));

  const baseOrigin = new URL(baseUrl).origin;
  for (const transition of transitions) {
    if (new URL(transition.from).origin !== new URL(transition.to).origin) {
      throw new Error(
        `${transition.name} is cross-origin. RoutePlay only clicks same-origin transitions.`,
      );
    }
    if (
      new URL(transition.from).origin !== baseOrigin ||
      new URL(transition.to).origin !== baseOrigin ||
      new URL(transition.expectedFinalUrl).origin !== baseOrigin
    ) {
      throw new Error(
        `${transition.name} must stay on the configured baseUrl origin ${baseOrigin}.`,
      );
    }
    for (const link of transition.expect?.linksInclude ?? []) {
      if (new URL(link).origin !== baseOrigin) {
        throw new Error(
          `${transition.name} expect.linksInclude must stay on the configured baseUrl origin ${baseOrigin}.`,
        );
      }
    }
  }

  return {
    ...parsed.data,
    baseUrl,
    transitions,
    headers,
    failOn: options.failOn ?? parsed.data.failOn,
    concurrency,
    retries,
    ...(artifacts === undefined ? {} : { artifacts }),
  };
}

export async function validateConfigFile(
  file: string,
): Promise<{ path: string; transitionCount: number }> {
  const absolute = path.resolve(file);
  const config = await loadConfig({ configPath: absolute });
  return { path: absolute, transitionCount: config.transitions.length };
}

export const defaultConfig = {
  $schema: "./node_modules/routeplay/routeplay.schema.json",
  baseUrl: "https://example.com",
  transitions: [
    {
      name: "Home to about",
      from: "/",
      to: "/about/",
      selector: "a[href='/about/']",
      requireClientNavigation: false,
      expect: {
        title: "About",
        canonical: "/about/",
        h1: ["About"],
        mainTextIncludes: ["About"],
      },
    },
  ],
  browser: {
    timeoutMs: 20_000,
    settleMs: 500,
    locale: "en-US",
    timezoneId: "UTC",
    viewport: { width: 1440, height: 900 },
  },
  compare: {
    minTextSimilarity: 0.98,
    minSourceTextLength: 80,
    compareLinks: true,
  },
  headers: {},
  failOn: "error",
} as const;
