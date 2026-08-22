import type { Server } from "node:http";
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
    const report = await runRoutePlay(config, browser);
    expect(report.results[0]?.complete).toBe(true);
    expect(report.results[0]?.navigation.mode).toBe("client");
    expect(report.summary.errors).toBe(0);
    expect(report.passed).toBe(true);
    expect(JSON.stringify(report)).not.toContain("super-secret-preview-value");
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
});
