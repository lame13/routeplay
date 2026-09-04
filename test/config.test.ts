import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, normalizeUrl, validateConfigFile } from "../src/config.js";

const previousToken = process.env.ROUTEPLAY_TEST_TOKEN;

afterEach(() => {
  if (previousToken === undefined) delete process.env.ROUTEPLAY_TEST_TOKEN;
  else process.env.ROUTEPLAY_TEST_TOKEN = previousToken;
});

describe("loadConfig", () => {
  it("normalizes routes, applies defaults, and expands environment headers", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "routeplay-config-"));
    const file = path.join(directory, "routeplay.config.json");
    process.env.ROUTEPLAY_TEST_TOKEN = "secret-value";
    await writeFile(
      file,
      JSON.stringify({
        baseUrl: "https://example.test/base/",
        headers: { "x-test": "${" + "ROUTEPLAY_TEST_TOKEN}" },
        transitions: [
          {
            from: "/",
            to: "/about/",
            expect: {
              title: "  About   us  ",
              description: "About this site",
              canonical: "/about/",
              h1: [" About us "],
              robots: { ROBOTS: ["INDEX", "follow", "INDEX"] },
              jsonLdTypesInclude: ["AboutPage", "AboutPage"],
              mainTextIncludes: ["Meet the team"],
              linksInclude: ["/contact/#team"],
            },
          },
        ],
      }),
    );
    const config = await loadConfig({ configPath: file });
    expect(config.transitions[0]).toMatchObject({
      name: "Transition 1",
      from: "https://example.test/",
      to: "https://example.test/about/",
      expectedFinalUrl: "https://example.test/about/",
      expectedStatus: 200,
      expect: {
        title: "About us",
        description: "About this site",
        canonical: "https://example.test/about/",
        h1: ["About us"],
        robots: { robots: ["follow", "index"] },
        jsonLdTypesInclude: ["AboutPage"],
        mainTextIncludes: ["Meet the team"],
        linksInclude: ["https://example.test/contact/"],
      },
    });
    expect(config.headers).toEqual({ "x-test": "secret-value" });
    expect(config.browser.timeoutMs).toBe(20_000);
  });

  it("rejects cross-origin click journeys", async () => {
    await expect(
      loadConfig({
        baseUrl: "https://example.test",
        from: "/",
        to: "https://other.test/",
      }),
    ).rejects.toThrow("cross-origin");
  });

  it("rejects transition origins that do not match baseUrl", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "routeplay-config-"));
    const file = path.join(directory, "routeplay.config.json");
    await writeFile(
      file,
      JSON.stringify({
        baseUrl: "https://example.test",
        transitions: [{ from: "https://other.test/", to: "https://other.test/about" }],
      }),
    );
    await expect(loadConfig({ configPath: file })).rejects.toThrow("baseUrl origin");
  });

  it("allows CLI baseUrl to retarget a committed preview config", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "routeplay-config-"));
    const file = path.join(directory, "routeplay.config.json");
    await writeFile(
      file,
      JSON.stringify({
        baseUrl: "https://production.test",
        transitions: [
          {
            from: "/",
            to: "/about/",
            expect: { canonical: "/about/", linksInclude: ["/contact/"] },
          },
        ],
      }),
    );
    const config = await loadConfig({ configPath: file, baseUrl: "https://preview.test" });
    expect(config.baseUrl).toBe("https://preview.test/");
    expect(config.transitions[0]?.to).toBe("https://preview.test/about/");
    expect(config.transitions[0]?.expect).toMatchObject({
      canonical: "https://preview.test/about/",
      linksInclude: ["https://preview.test/contact/"],
    });
  });

  it("rejects empty route contracts and cross-origin required links", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "routeplay-config-"));
    const emptyFile = path.join(directory, "empty.json");
    const crossOriginFile = path.join(directory, "cross-origin.json");
    await writeFile(
      emptyFile,
      JSON.stringify({
        baseUrl: "https://example.test",
        transitions: [{ from: "/", to: "/about/", expect: {} }],
      }),
    );
    await writeFile(
      crossOriginFile,
      JSON.stringify({
        baseUrl: "https://example.test",
        transitions: [
          {
            from: "/",
            to: "/about/",
            expect: { linksInclude: ["https://other.test/contact/"] },
          },
        ],
      }),
    );

    await expect(loadConfig({ configPath: emptyFile })).rejects.toThrow(
      "Add at least one route expectation",
    );
    await expect(loadConfig({ configPath: crossOriginFile })).rejects.toThrow(
      "expect.linksInclude must stay",
    );
  });

  it("rejects misspelled configuration keys", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "routeplay-config-"));
    const file = path.join(directory, "routeplay.config.json");
    await writeFile(
      file,
      JSON.stringify({
        $schema: "./routeplay.schema.json",
        baseUrl: "https://example.test",
        transitions: [{ from: "/", to: "/about", expectedStats: 200 }],
      }),
    );
    await expect(loadConfig({ configPath: file })).rejects.toThrow("Unrecognized key");
  });

  it("does not include header values in missing-environment errors", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "routeplay-config-"));
    const file = path.join(directory, "routeplay.config.json");
    delete process.env.ROUTEPLAY_TEST_TOKEN;
    await writeFile(
      file,
      JSON.stringify({
        baseUrl: "https://example.test",
        headers: { Authorization: "Bearer ${" + "ROUTEPLAY_TEST_TOKEN}" },
        transitions: [{ from: "/", to: "/about" }],
      }),
    );
    await expect(loadConfig({ configPath: file })).rejects.toThrow(
      "Authorization references missing environment variable ROUTEPLAY_TEST_TOKEN",
    );
  });

  it("validates a config file and reports its transition count", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "routeplay-config-"));
    const file = path.join(directory, "routeplay.config.json");
    await writeFile(
      file,
      JSON.stringify({
        baseUrl: "https://example.test",
        transitions: [
          { from: "/", to: "/about" },
          { from: "/about", to: "/contact" },
        ],
      }),
    );

    await expect(validateConfigFile(file)).resolves.toEqual({
      path: file,
      transitionCount: 2,
    });
  });
});

describe("normalizeUrl", () => {
  it("preserves query strings and trailing slashes", () => {
    expect(normalizeUrl("https://example.test", "/docs/?page=2")).toBe(
      "https://example.test/docs/?page=2",
    );
  });
});
