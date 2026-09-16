import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchBrowser } from "../src/browser.js";
import { loadConfig } from "../src/config.js";
import { runRoutePlay } from "../src/run.js";
import { startFixtureServer } from "./fixture-server.js";

let servers: Server[];
let browser: Browser;
let baseUrl: string;
let crossOriginHits: () => number;
let crossOriginAuthorizations: () => Array<string | undefined>;

beforeAll(async () => {
  const fixture = await startFixtureServer();
  servers = fixture.servers;
  baseUrl = fixture.baseUrl;
  crossOriginHits = fixture.crossOriginHits;
  crossOriginAuthorizations = fixture.crossOriginAuthorizations;
  browser = await launchBrowser();
});

afterAll(async () => {
  await browser.close();
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
});

describe("browser integration", () => {
  it("passes a healthy soft transition", async () => {
    const config = await loadConfig({ baseUrl, from: "/", to: "/good/" });
    config.compare.minSourceTextLength = 20;
    config.headers.authorization = "super-secret-preview-value";
    const transition = config.transitions[0];
    if (!transition) throw new Error("Expected one configured transition.");
    transition.requireClientNavigation = true;
    transition.expect = {
      title: "Good",
      description: "Fixture Good",
      canonical: `${baseUrl}/good/`,
      h1: ["Good"],
      robots: { robots: ["follow", "index"] },
      mainTextIncludes: ["complete stable content"],
      linksInclude: [`${baseUrl}/`],
    };
    const report = await runRoutePlay(config, browser);
    expect(report.results[0]?.complete).toBe(true);
    expect(report.results[0]?.navigation.mode).toBe("client");
    expect(report.summary.errors).toBe(0);
    expect(report.passed).toBe(true);
    expect(JSON.stringify(report)).not.toContain("super-secret-preview-value");
  });

  it("fails a wrong route contract even when every surface agrees", async () => {
    const config = await loadConfig({ baseUrl, from: "/", to: "/good/" });
    const transition = config.transitions[0];
    if (!transition) throw new Error("Expected one configured transition.");
    transition.expect = { title: "Pricing" };
    const report = await runRoutePlay(config, browser);

    expect(report.results[0]?.complete).toBe(true);
    expect(report.results[0]?.findings).toContainEqual(
      expect.objectContaining({ ruleId: "RP301", severity: "error" }),
    );
    expect(report.passed).toBe(false);
  });

  it("detects hydrated-only source content", async () => {
    const config = await loadConfig({ baseUrl, from: "/", to: "/thin/" });
    config.compare.minSourceTextLength = 40;
    const report = await runRoutePlay(config, browser);
    expect(report.results[0]?.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: "RP102", comparison: "server-cold" }),
        expect.objectContaining({ ruleId: "RP109", phase: "server" }),
      ]),
    );
  });

  it("fails stale canonical state after client navigation", async () => {
    const config = await loadConfig({ baseUrl, from: "/", to: "/stale/" });
    const report = await runRoutePlay(config, browser);
    expect(report.results[0]?.findings).toContainEqual(
      expect.objectContaining({
        ruleId: "RP104",
        comparison: "cold-transition",
        severity: "error",
      }),
    );
    expect(report.passed).toBe(false);
  });

  it("fails when a configured source link exists only after JavaScript", async () => {
    const config = await loadConfig({ baseUrl, from: "/js-source/", to: "/good/" });
    const report = await runRoutePlay(config, browser);
    expect(report.results[0]?.findings).toContainEqual(
      expect.objectContaining({ ruleId: "RP113", severity: "error" }),
    );
  });

  it("allows an explicitly expected 404 document route", async () => {
    const config = await loadConfig({ baseUrl, from: "/", to: "/missing/" });
    const transition = config.transitions[0];
    if (!transition) throw new Error("Expected one configured transition.");
    transition.expectedStatus = 404;
    const report = await runRoutePlay(config, browser);
    expect(report.results[0]?.complete).toBe(true);
    expect(report.results[0]?.navigation.mode).toBe("document");
    expect(report.summary.errors).toBe(0);
  });

  it("fails a route that redirects to an unexpected final URL", async () => {
    const config = await loadConfig({ baseUrl, from: "/", to: "/redirect-wrong/" });
    const report = await runRoutePlay(config, browser);
    expect(report.results[0]?.findings).toContainEqual(
      expect.objectContaining({ ruleId: "RP101", severity: "error" }),
    );
  });

  it("allows a declared final URL after a normalization redirect", async () => {
    const config = await loadConfig({ baseUrl, from: "/", to: "/redirect-ok" });
    const transition = config.transitions[0];
    if (!transition) throw new Error("Expected one configured transition.");
    transition.expectedFinalUrl = `${baseUrl}/redirect-ok/`;
    const report = await runRoutePlay(config, browser);
    expect(report.results[0]?.complete).toBe(true);
    expect(report.summary.errors).toBe(0);
  });

  it("redacts reflected header values from reports", async () => {
    const config = await loadConfig({ baseUrl, from: "/", to: "/reflect/" });
    config.headers.authorization = "Bearer reflected-secret-value";
    const report = await runRoutePlay(config, browser);
    expect(JSON.stringify(report)).not.toContain("reflected-secret-value");
    expect(JSON.stringify(report)).toContain("[REDACTED]");
  });

  it("captures browser exceptions and failed same-origin data responses", async () => {
    const config = await loadConfig({ baseUrl, from: "/", to: "/runtime/" });
    const report = await runRoutePlay(config, browser);
    expect(report.results[0]?.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: "RP201", severity: "error" }),
        expect.objectContaining({ ruleId: "RP204", severity: "error" }),
      ]),
    );
  });

  it("strips credentials from cross-origin redirects", async () => {
    const config = await loadConfig({ baseUrl, from: "/", to: "/cross-origin/" });
    config.headers.authorization = "Bearer must-not-leak";
    config.browser.timeoutMs = 5_000;
    const before = crossOriginHits();
    const report = await runRoutePlay(config, browser);
    expect(report.results[0]?.complete).toBe(true);
    expect(crossOriginHits()).toBeGreaterThan(before);
    expect(crossOriginAuthorizations()).not.toContain("Bearer must-not-leak");
  });

  it("retries an unstable transition and reports the attempt count", async () => {
    const artifactsDir = await mkdtemp(path.join(tmpdir(), "routeplay-artifacts-"));
    const config = await loadConfig({ baseUrl, from: "/", to: "/never-stable/" });
    config.browser.timeoutMs = 1_500;
    config.retries = 1;
    config.failOn = "never";
    config.artifacts = artifactsDir;
    const report = await runRoutePlay(config, browser);

    expect(report.run).toEqual({ concurrency: 1, retries: 1 });
    expect(report.results[0]?.attempts).toBe(2);
    expect(report.results[0]?.complete).toBe(false);
    expect(report.results[0]?.findings).toContainEqual(
      expect.objectContaining({ ruleId: "RP001", severity: "error" }),
    );
    expect(Object.keys(report.results[0]?.artifacts ?? {})).toEqual(
      expect.arrayContaining(["cold.html", "cold.png", "runtime.json"]),
    );
  });

  it("recovers a transition that only fails on its first attempt", async () => {
    const config = await loadConfig({ baseUrl, from: "/", to: "/retry-once/" });
    const directory = await mkdtemp(path.join(tmpdir(), "routeplay-recovery-"));
    config.artifacts = path.join(directory, "artifacts");
    config.browser.timeoutMs = 1_500;
    config.retries = 1;
    const report = await runRoutePlay(config, browser);

    expect(report.results[0]?.complete).toBe(true);
    expect(report.results[0]?.attempts).toBe(2);
    expect(report.passed).toBe(true);
    expect(report.results[0]?.durationMs).toBeGreaterThan(2_500);
    expect(await readdir(directory)).toEqual([]);
  });

  it("samples custom elements without running their constructors again", async () => {
    const config = await loadConfig({
      baseUrl,
      from: "/custom-element/",
      to: "/custom-element/",
    });
    config.browser.timeoutMs = 1_500;
    const report = await runRoutePlay(config, browser);

    expect(report.results[0]?.complete).toBe(true);
    expect(report.results[0]?.captures?.cold.semantic.titles).toEqual(["Constructed 1"]);
    expect(report.results[0]?.captures?.transition.semantic.titles).toEqual(["Constructed 1"]);
  });

  it.each([
    { from: "/", to: "/connection-failure/", phase: "cold", kind: "request-failed" },
    { from: "/missing-source/", to: "/good/", phase: "source", kind: "http-error" },
  ])("keeps evidence for early navigation failure at $phase", async ({ from, to, phase, kind }) => {
    const artifactsDir = await mkdtemp(path.join(tmpdir(), "routeplay-navigation-failure-"));
    const config = await loadConfig({ baseUrl, from, to });
    config.browser.timeoutMs = 1_500;
    config.artifacts = artifactsDir;
    const report = await runRoutePlay(config, browser);

    expect(report.results[0]?.complete).toBe(false);
    const artifacts = report.results[0]?.artifacts ?? {};
    // A refused connection may never expose a document, but request evidence must survive.
    if (phase === "source") expect(artifacts["source.html"]).toBeDefined();
    expect(artifacts["runtime.json"]).toBeDefined();
    const runtime = JSON.parse(
      await readFile(path.join(artifactsDir, artifacts["runtime.json"] ?? ""), "utf8"),
    );
    expect(runtime).toContainEqual(
      expect.objectContaining({
        events: expect.arrayContaining([expect.objectContaining({ kind })]),
      }),
    );
  });

  it("writes failure artifacts with redacted credentials", async () => {
    const artifactsDir = await mkdtemp(path.join(tmpdir(), "routeplay-artifacts-"));
    const config = await loadConfig({ baseUrl, from: "/", to: "/reflect/" });
    config.headers.authorization = 'Bearer artifact-secret-value&<tag>"';
    config.artifacts = artifactsDir;
    config.retries = 1;
    const transition = config.transitions[0];
    if (!transition) throw new Error("Expected one configured transition.");
    transition.expect = { title: "Deliberately wrong" };
    const report = await runRoutePlay(config, browser);

    expect(report.passed).toBe(false);
    expect(report.results[0]?.attempts).toBe(2);
    const artifacts = report.results[0]?.artifacts ?? {};
    expect(Object.keys(artifacts).sort()).toEqual([
      "cold.html",
      "cold.png",
      "runtime.json",
      "transition.html",
      "transition.png",
    ]);
    const html = await readFile(path.join(artifactsDir, artifacts["cold.html"] ?? ""), "utf8");
    expect(html).not.toContain("artifact-secret-value");
    expect(html).toContain("[REDACTED]");
    const runtime = await readFile(
      path.join(artifactsDir, artifacts["runtime.json"] ?? ""),
      "utf8",
    );
    expect(runtime).not.toContain("artifact-secret-value");
    expect(JSON.stringify(report)).not.toContain("artifact-secret-value");
  });

  it("writes no artifacts for a passing transition", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "routeplay-artifacts-pass-"));
    const artifactsDir = path.join(directory, "artifacts");
    const config = await loadConfig({ baseUrl, from: "/", to: "/good/" });
    config.compare.minSourceTextLength = 20;
    config.artifacts = artifactsDir;
    const report = await runRoutePlay(config, browser);

    expect(report.passed).toBe(true);
    expect(report.results[0]?.artifacts).toBeUndefined();
    expect(await readdir(directory)).toEqual([]);
  });

  it.each([
    { failOn: "error" as const, attempts: 1, passed: true },
    { failOn: "warning" as const, attempts: 2, passed: false },
    { failOn: "never" as const, attempts: 1, passed: true },
  ])("retries warnings according to the $failOn policy", async ({ failOn, attempts, passed }) => {
    const config = await loadConfig({ baseUrl, from: "/", to: "/good/", failOn, retries: 1 });
    config.compare.minSourceTextLength = 1_000;
    config.browser.settleMs = 100;
    const report = await runRoutePlay(config, browser);
    expect(report.summary.warnings).toBeGreaterThan(0);
    expect(report.results[0]?.attempts).toBe(attempts);
    expect(report.passed).toBe(passed);
  });

  it("captures transitions concurrently while preserving configured order", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "routeplay-parallel-"));
    const file = path.join(directory, "routeplay.config.json");
    await writeFile(
      file,
      JSON.stringify({
        baseUrl,
        concurrency: 3,
        transitions: [
          { name: "First", from: "/", to: "/good/" },
          { name: "Second", from: "/", to: "/missing/", expectedStatus: 404 },
          { name: "Third", from: "/", to: "/stale/" },
        ],
      }),
    );
    const config = await loadConfig({ configPath: file });
    const report = await runRoutePlay(config, browser);

    expect(report.run).toEqual({ concurrency: 3, retries: 0 });
    expect(report.results.map((result) => result.name)).toEqual(["First", "Second", "Third"]);
    expect(report.results.every((result) => result.complete)).toBe(true);
    expect(report.results[0]?.attempts).toBe(1);
  });

  it("waits for active workers to close their contexts when artifact writing fails", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "routeplay-write-failure-"));
    const config = await loadConfig({ baseUrl, from: "/", to: "/good/" });
    const transition = config.transitions[0];
    if (!transition) throw new Error("Expected one configured transition.");
    config.transitions = [
      { ...transition, name: "Blocked", expect: { title: "Wrong title" } },
      { ...transition, name: "Slow", to: `${baseUrl}/never-stable/` },
    ];
    config.browser.timeoutMs = 3_000;
    config.concurrency = 2;
    config.artifacts = directory;
    await writeFile(path.join(directory, "01-blocked"), "This file blocks the artifact directory");

    await expect(runRoutePlay(config, browser)).rejects.toThrow();
    expect(browser.contexts()).toHaveLength(0);
  });
});
