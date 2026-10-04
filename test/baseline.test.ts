import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  baselineFromReport,
  loadBaseline,
  mergeBaseline,
  readBaselineIfPresent,
  transitionSpecHash,
  writeBaseline,
} from "../src/baseline.js";
import { loadConfig } from "../src/config.js";
import { extractSemantics } from "../src/extract.js";
import type { Capture, RoutePlayConfig, RoutePlayReport, TransitionSpec } from "../src/types.js";

const baseUrl = "https://example.test";

async function config(extra: Record<string, unknown> = {}): Promise<RoutePlayConfig> {
  const directory = await mkdtemp(path.join(tmpdir(), "routeplay-baseline-"));
  const file = path.join(directory, "routeplay.config.json");
  await writeFile(
    file,
    JSON.stringify({ baseUrl, transitions: [{ from: "/", to: "/page/" }], ...extra }),
  );
  return loadConfig({ configPath: file });
}

function capture(phase: Capture["phase"], html: string): Capture {
  return {
    phase,
    semantic: extractSemantics(html, `${baseUrl}/page/`),
    runtime: [],
  };
}

function reportFor(configValue: RoutePlayConfig, html: string, complete = true): RoutePlayReport {
  const spec = configValue.transitions[0] as TransitionSpec;
  return {
    schemaVersion: 1,
    tool: { name: "routeplay", version: "0.5.0" },
    startedAt: "2026-10-04T00:00:00.000Z",
    finishedAt: "2026-10-04T00:00:01.000Z",
    durationMs: 1000,
    baseUrl: configValue.baseUrl,
    environment: {
      browser: "chromium",
      locale: "en-US",
      timezoneId: "UTC",
      viewport: { width: 1440, height: 900 },
    },
    policy: { failOn: "error" },
    run: { concurrency: 1, retries: 0, repeat: 1 },
    results: [
      {
        name: spec.name,
        from: spec.from,
        to: spec.to,
        navigation: { mode: "client" },
        ...(complete
          ? {
              captures: {
                server: capture("server", html),
                cold: capture("cold", html),
                transition: capture("transition", html),
              },
            }
          : {}),
        findings: [],
        durationMs: 1000,
        attempts: 1,
        complete,
      },
    ],
    summary: {
      transitions: 1,
      passed: complete ? 1 : 0,
      failed: complete ? 0 : 1,
      incomplete: complete ? 0 : 1,
      errors: 0,
      warnings: 0,
      info: 0,
      suppressed: 0,
    },
    passed: complete,
  };
}

const page = "<title>Page</title><main><h1>Page</h1><p>Stable recorded content.</p></main>";

describe("transitionSpecHash", () => {
  it("is stable for the same capture settings", async () => {
    const value = await config();
    const spec = value.transitions[0] as TransitionSpec;
    expect(transitionSpecHash(value, spec)).toBe(transitionSpecHash(value, spec));
  });

  it("changes when capture settings change and ignores contract expectations", async () => {
    const value = await config();
    const spec = value.transitions[0] as TransitionSpec;
    const original = transitionSpecHash(value, spec);

    expect(transitionSpecHash(value, { ...spec, to: `${baseUrl}/other/` })).not.toBe(original);
    expect(transitionSpecHash(value, { ...spec, from: `${baseUrl}/other/` })).not.toBe(original);
    expect(transitionSpecHash(value, { ...spec, selector: "a.secondary" })).not.toBe(original);
    expect(transitionSpecHash(value, { ...spec, readySelector: "#ready" })).not.toBe(original);
    expect(
      transitionSpecHash({ ...value, browser: { ...value.browser, settleMs: 1000 } }, spec),
    ).not.toBe(original);
    expect(transitionSpecHash(value, { ...spec, ignoreSelectors: ["[data-live]"] })).not.toBe(
      original,
    );
    expect(
      transitionSpecHash({ ...value, browser: { ...value.browser, locale: "th-TH" } }, spec),
    ).not.toBe(original);
    expect(transitionSpecHash(value, { ...spec, expect: { title: "Anything" } })).toBe(original);
  });
});

describe("baselineFromReport", () => {
  it("records every complete transition and skips incomplete ones", async () => {
    const value = await config();
    const recorded = baselineFromReport(reportFor(value, page), value);

    expect(recorded.skipped).toEqual([]);
    expect(recorded.baseline.transitions).toHaveLength(1);
    expect(recorded.baseline.transitions[0]).toMatchObject({
      name: "Transition 1",
      to: `${baseUrl}/page/`,
      specHash: transitionSpecHash(value, value.transitions[0] as TransitionSpec),
    });
    expect(recorded.baseline.transitions[0]?.phases.cold.titles).toEqual(["Page"]);

    const incomplete = baselineFromReport(reportFor(value, page, false), value);
    expect(incomplete.baseline.transitions).toEqual([]);
    expect(incomplete.skipped).toEqual(["Transition 1"]);
  });
});

describe("baseline files", () => {
  it("round-trips through disk", async () => {
    const value = await config();
    const directory = await mkdtemp(path.join(tmpdir(), "routeplay-baseline-"));
    const file = path.join(directory, "nested", "routeplay.baseline.json");
    const { baseline } = baselineFromReport(reportFor(value, page), value);

    const written = await writeBaseline(file, baseline, value);
    expect(written).toBe(file);
    await expect(loadBaseline(file)).resolves.toEqual(baseline);
  });

  it("redacts cookie secrets from the recorded evidence", async () => {
    const value = await config({
      browser: { cookies: [{ name: "session", value: "baseline-cookie-secret" }] },
    });
    const directory = await mkdtemp(path.join(tmpdir(), "routeplay-baseline-"));
    const file = path.join(directory, "routeplay.baseline.json");
    const html =
      "<title>Page</title><main><h1>Page</h1><p>Signed in as baseline-cookie-secret.</p></main>";
    const { baseline } = baselineFromReport(reportFor(value, html), value);

    await writeBaseline(file, baseline, value);
    const raw = await readFile(file, "utf8");
    expect(raw).not.toContain("baseline-cookie-secret");
    expect(raw).toContain("[REDACTED]");
  });

  it("rejects unreadable, malformed, and wrongly versioned baselines", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "routeplay-baseline-"));
    const malformed = path.join(directory, "malformed.json");
    const wrongVersion = path.join(directory, "wrong-version.json");
    await writeFile(malformed, "{oops");
    await writeFile(
      wrongVersion,
      JSON.stringify({
        schemaVersion: 99,
        tool: { name: "routeplay", version: "0.5.0" },
        baseUrl,
        recordedAt: "2026-10-04T00:00:00.000Z",
        transitions: [],
      }),
    );

    await expect(loadBaseline(path.join(directory, "missing.json"))).rejects.toThrow(
      "Could not read baseline",
    );
    await expect(loadBaseline(malformed)).rejects.toThrow("Invalid JSON in baseline");
    await expect(loadBaseline(wrongVersion)).rejects.toThrow("Invalid RoutePlay baseline");
    await expect(readBaselineIfPresent(malformed)).rejects.toThrow("Invalid JSON in baseline");
    await expect(readBaselineIfPresent(wrongVersion)).rejects.toThrow("Invalid RoutePlay baseline");
    await expect(readBaselineIfPresent(directory)).rejects.toThrow("Could not read baseline");
  });

  it("redacts credentials in baseline URLs and metadata using report redaction", async () => {
    const secret = "private<token>&value";
    const value = await config({ headers: { authorization: secret } });
    const { baseline } = baselineFromReport(reportFor(value, page), value);
    baseline.baseUrl += `/?token=${encodeURIComponent(secret)}`;
    const entry = baseline.transitions[0];
    if (!entry) throw new Error("Expected a baseline entry.");
    entry.name = secret;
    entry.phases.server.url += `?token=${encodeURIComponent(secret)}`;
    const directory = await mkdtemp(path.join(tmpdir(), "routeplay-baseline-"));
    const file = path.join(directory, "redacted.json");
    await writeBaseline(file, baseline, value);
    const raw = await readFile(file, "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain(encodeURIComponent(secret));
    expect(raw).toContain("[REDACTED]");
  });

  it("keeps entries that a scoped re-record did not touch", async () => {
    const value = await config();
    const directory = await mkdtemp(path.join(tmpdir(), "routeplay-baseline-"));
    const file = path.join(directory, "routeplay.baseline.json");
    const first = baselineFromReport(reportFor(value, page), value).baseline;
    await writeBaseline(file, first, value);

    const fresh = baselineFromReport(reportFor(value, page), value).baseline;
    const renamed = structuredClone(fresh);
    const renamedEntry = renamed.transitions[0];
    if (!renamedEntry) throw new Error("Expected one recorded transition.");
    renamed.transitions[0] = { ...renamedEntry, name: "Renamed transition" };
    const merged = mergeBaseline(await readBaselineIfPresent(file), renamed);

    expect(merged).toMatchObject({ added: 1, replaced: 0, retained: 1 });
    expect(merged.baseline.transitions.map((entry) => entry.name)).toEqual([
      "Renamed transition",
      "Transition 1",
    ]);

    const overwritten = mergeBaseline(await readBaselineIfPresent(file), fresh);
    expect(overwritten).toMatchObject({ added: 0, replaced: 1, retained: 0 });
    expect(overwritten.baseline.transitions).toHaveLength(1);
  });

  it("writes a fresh baseline when no previous file exists", async () => {
    const value = await config();
    const directory = await mkdtemp(path.join(tmpdir(), "routeplay-baseline-"));
    await expect(
      readBaselineIfPresent(path.join(directory, "absent.json")),
    ).resolves.toBeUndefined();
    const fresh = baselineFromReport(reportFor(value, page), value).baseline;
    expect(mergeBaseline(undefined, fresh)).toMatchObject({ added: 1, replaced: 0, retained: 0 });
  });
});
