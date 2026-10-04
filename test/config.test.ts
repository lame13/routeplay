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
  it("rejects duplicate transition names used for baseline identity", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "routeplay-config-"));
    const file = path.join(directory, "config.json");
    await writeFile(
      file,
      JSON.stringify({
        baseUrl: "https://example.test",
        transitions: [
          { name: "same", from: "/", to: "/a/" },
          { name: "same", from: "/", to: "/b/" },
        ],
      }),
    );
    await expect(loadConfig({ configPath: file })).rejects.toThrow(
      "Transition names must be unique",
    );
  });

  it.each([
    { url: "https://example.test/", path: "/private" },
    { url: "https://example.test/", domain: "example.test" },
    { path: "private" },
  ])("rejects ambiguous or invalid cookie locations: %j", async (location) => {
    const directory = await mkdtemp(path.join(tmpdir(), "routeplay-config-"));
    const file = path.join(directory, "config.json");
    await writeFile(
      file,
      JSON.stringify({
        baseUrl: "https://example.test",
        transitions: [{ from: "/", to: "/a/" }],
        browser: { cookies: [{ name: "session", value: "secret", ...location }] },
      }),
    );
    await expect(loadConfig({ configPath: file })).rejects.toThrow("Invalid RoutePlay config");
  });
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

  it("applies run defaults and accepts concurrency, retry, and artifact settings", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "routeplay-config-"));
    const file = path.join(directory, "routeplay.config.json");
    await writeFile(
      file,
      JSON.stringify({
        baseUrl: "https://example.test",
        concurrency: 4,
        retries: 2,
        artifacts: "reports/routeplay-artifacts",
        transitions: [{ from: "/", to: "/about" }],
      }),
    );
    const config = await loadConfig({ configPath: file });
    expect(config.concurrency).toBe(4);
    expect(config.retries).toBe(2);
    expect(config.artifacts).toBe("reports/routeplay-artifacts");

    const defaults = await loadConfig({
      baseUrl: "https://example.test",
      from: "/",
      to: "/about",
    });
    expect(defaults.concurrency).toBe(1);
    expect(defaults.retries).toBe(0);
    expect(defaults.artifacts).toBeUndefined();
  });

  it("lets CLI overrides retune a committed config and rejects out-of-range counts", async () => {
    const override = await loadConfig({
      baseUrl: "https://example.test",
      from: "/",
      to: "/about",
      concurrency: 3,
      retries: 1,
      artifacts: "routeplay-artifacts",
    });
    expect(override.concurrency).toBe(3);
    expect(override.retries).toBe(1);
    expect(override.artifacts).toBe("routeplay-artifacts");

    await expect(
      loadConfig({ baseUrl: "https://example.test", from: "/", to: "/about", concurrency: 0 }),
    ).rejects.toThrow("Concurrency must be an integer between 1 and 8.");
    await expect(
      loadConfig({ baseUrl: "https://example.test", from: "/", to: "/about", retries: 1.5 }),
    ).rejects.toThrow("Retries must be an integer between 0 and 3.");
    await expect(
      loadConfig({ baseUrl: "https://example.test", from: "/", to: "/about", artifacts: "  " }),
    ).rejects.toThrow("Artifacts directory must not be empty.");
  });

  it("defaults and normalizes change-scoped paths and contract language", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "routeplay-config-"));
    const file = path.join(directory, "routeplay.config.json");
    await writeFile(
      file,
      JSON.stringify({
        baseUrl: "https://example.test",
        transitions: [
          {
            from: "/",
            to: "/about",
            paths: [" app/about/** ", "content/about/*.md"],
            expect: { lang: " TH-th " },
          },
          { from: "/", to: "/contact" },
        ],
      }),
    );
    const config = await loadConfig({ configPath: file });

    expect(config.transitions[0]?.paths).toEqual(["app/about/**", "content/about/*.md"]);
    expect(config.transitions[0]?.expect).toMatchObject({ lang: "th-th" });
    expect(config.transitions[1]?.paths).toEqual([]);
  });

  it("reads storage state, seeds cookies from the environment, and accepts CLI overrides", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "routeplay-config-"));
    const file = path.join(directory, "routeplay.config.json");
    process.env.ROUTEPLAY_TEST_TOKEN = "cookie-secret-value";
    await writeFile(
      file,
      JSON.stringify({
        baseUrl: "https://example.test",
        browser: {
          storageState: ".auth/user.json",
          cookies: [
            {
              name: "session",
              value: "${" + "ROUTEPLAY_TEST_TOKEN}",
              domain: "example.test",
              httpOnly: true,
            },
          ],
        },
        transitions: [{ from: "/", to: "/about" }],
      }),
    );
    const config = await loadConfig({ configPath: file });

    expect(config.browser.storageState).toBe(".auth/user.json");
    expect(config.browser.cookies).toEqual([
      {
        name: "session",
        value: "cookie-secret-value",
        domain: "example.test",
        httpOnly: true,
      },
    ]);

    const overridden = await loadConfig({
      configPath: file,
      storageState: "other/state.json",
    });
    expect(overridden.browser.storageState).toBe("other/state.json");
    await expect(
      loadConfig({ baseUrl: "https://example.test", from: "/", to: "/about", storageState: "" }),
    ).rejects.toThrow("Storage state path must not be empty.");
  });

  it("validates suppressions against the configured transitions", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "routeplay-config-"));
    const file = path.join(directory, "routeplay.config.json");
    await writeFile(
      file,
      JSON.stringify({
        baseUrl: "https://example.test",
        transitions: [{ name: "Home to pricing", from: "/", to: "/pricing" }],
        ignore: [
          {
            ruleId: "rp108",
            transition: "Home to pricing",
            reason: "Tracked in SEO-142",
            until: "2026-12-01",
          },
        ],
      }),
    );
    const config = await loadConfig({ configPath: file });
    expect(config.ignore).toEqual([
      {
        ruleId: "RP108",
        transition: "Home to pricing",
        reason: "Tracked in SEO-142",
        until: "2026-12-01",
      },
    ]);

    const write = async (ignore: unknown, name = "ignore.json"): Promise<string> => {
      const target = path.join(directory, name);
      await writeFile(
        target,
        JSON.stringify({
          baseUrl: "https://example.test",
          transitions: [{ name: "Home to pricing", from: "/", to: "/pricing" }],
          ignore,
        }),
      );
      return target;
    };

    await expect(
      loadConfig({
        configPath: await write([{ ruleId: "RP108", transition: "Unknown", reason: "Why not" }]),
      }),
    ).rejects.toThrow("does not match any configured transition");
    await expect(
      loadConfig({
        configPath: await write([{ ruleId: "seo", reason: "Too vague" }], "rule.json"),
      }),
    ).rejects.toThrow("Use a rule ID like RP108");
    await expect(
      loadConfig({
        configPath: await write(
          [{ ruleId: "RP108", reason: "Typo date", until: "2026-02-31" }],
          "date.json",
        ),
      }),
    ).rejects.toThrow("Use a real calendar date");
  });

  it("applies repeat defaults and rejects out-of-range repeat counts", async () => {
    const defaults = await loadConfig({
      baseUrl: "https://example.test",
      from: "/",
      to: "/about",
    });
    expect(defaults.repeat).toBe(1);
    expect(defaults.ignore).toEqual([]);
    expect(defaults.browser.cookies).toEqual([]);

    const configured = await loadConfig({
      baseUrl: "https://example.test",
      from: "/",
      to: "/about",
      repeat: 3,
    });
    expect(configured.repeat).toBe(3);

    await expect(
      loadConfig({ baseUrl: "https://example.test", from: "/", to: "/about", repeat: 6 }),
    ).rejects.toThrow("Repeat must be an integer between 1 and 5.");
    await expect(
      loadConfig({ baseUrl: "https://example.test", from: "/", to: "/about", repeat: 1.5 }),
    ).rejects.toThrow("Repeat must be an integer between 1 and 5.");
  });
});

describe("normalizeUrl", () => {
  it("preserves query strings and trailing slashes", () => {
    expect(normalizeUrl("https://example.test", "/docs/?page=2")).toBe(
      "https://example.test/docs/?page=2",
    );
  });
});
