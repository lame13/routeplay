import { describe, expect, it } from "vitest";
import { analyzeCaptures } from "../src/analyze.js";
import { extractSemantics } from "../src/extract.js";
import type { Capture, TransitionSpec } from "../src/types.js";

const spec: TransitionSpec = {
  name: "Test",
  from: "https://example.test/",
  to: "https://example.test/page/",
  expectedFinalUrl: "https://example.test/page/",
  ignoreSelectors: [],
  expectedStatus: 200,
  requireClientNavigation: true,
};

function capture(phase: Capture["phase"], html: string): Capture {
  return {
    phase,
    semantic: extractSemantics(html, "https://example.test/page/"),
    runtime: [],
    ...(phase === "server"
      ? {
          http: {
            requestedUrl: spec.to,
            responseUrl: spec.to,
            status: 200,
            contentType: "text/html",
            redirects: [spec.to],
            xRobotsTag: [],
          },
        }
      : {}),
  };
}

describe("analyzeCaptures", () => {
  it("flags source-only gaps and cold-transition SEO drift", () => {
    const server = capture("server", "<title>Loading</title><main>Wait</main>");
    const cold = capture(
      "cold",
      '<title>Page</title><link rel="canonical" href="/page/"><main><h1>Page</h1><p>Complete useful route content for visitors and crawlers.</p></main>',
    );
    const transition = capture(
      "transition",
      '<title>Old</title><link rel="canonical" href="/"><main><h1>Page</h1><p>Complete useful route content for visitors and crawlers.</p></main>',
    );
    const findings = analyzeCaptures(spec, server, cold, transition, "client", true, {
      minTextSimilarity: 0.98,
      minSourceTextLength: 20,
      compareLinks: true,
    });
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: "RP109", severity: "warning" }),
        expect.objectContaining({
          ruleId: "RP102",
          comparison: "cold-transition",
          severity: "error",
        }),
        expect.objectContaining({
          ruleId: "RP104",
          comparison: "cold-transition",
          severity: "error",
        }),
      ]),
    );
  });

  it("fails a required soft navigation when a document load is observed", () => {
    const html =
      "<title>Page</title><main><h1>Page</h1><p>Long enough stable content for the route.</p></main>";
    const findings = analyzeCaptures(
      spec,
      capture("server", html),
      capture("cold", html),
      capture("transition", html),
      "document",
      true,
      { minTextSimilarity: 0.98, minSourceTextLength: 10, compareLinks: true },
    );
    expect(findings).toContainEqual(
      expect.objectContaining({ ruleId: "RP004", severity: "error" }),
    );
  });

  it("passes explicit route contracts on every surface", () => {
    const html = `<title>Page</title>
      <meta name="description" content="A useful destination">
      <meta name="robots" content="index, follow">
      <link rel="canonical" href="/page/">
      <script type="application/ld+json">{"@type":"Product"}</script>
      <main><h1>Page</h1><p>Complete useful route content for visitors and crawlers.</p>
        <a href="/signup/">Start free</a></main>`;
    const contractSpec: TransitionSpec = {
      ...spec,
      expect: {
        title: "Page",
        description: "A useful destination",
        canonical: "https://example.test/page/",
        h1: ["Page"],
        robots: { robots: ["follow", "index"] },
        jsonLdTypesInclude: ["Product"],
        mainTextIncludes: ["useful route content"],
        linksInclude: ["https://example.test/signup/"],
      },
    };
    const findings = analyzeCaptures(
      contractSpec,
      capture("server", html),
      capture("cold", html),
      capture("transition", html),
      "client",
      true,
      { minTextSimilarity: 0.98, minSourceTextLength: 10, compareLinks: true },
    );

    expect(findings.filter((finding) => finding.ruleId.startsWith("RP3"))).toEqual([]);
  });

  it("fails when matching surfaces all violate the route contract", () => {
    const html = `<title>Old page</title>
      <meta name="description" content="Old description">
      <meta name="robots" content="noindex">
      <link rel="canonical" href="/old/">
      <main><h1>Old page</h1><p>Old but consistent content.</p></main>`;
    const contractSpec: TransitionSpec = {
      ...spec,
      expect: {
        title: "Page",
        description: "A useful destination",
        canonical: "https://example.test/page/",
        h1: ["Page"],
        robots: { robots: ["follow", "index"] },
        jsonLdTypesInclude: ["Product"],
        mainTextIncludes: ["useful route content"],
        linksInclude: ["https://example.test/signup/"],
      },
    };
    const findings = analyzeCaptures(
      contractSpec,
      capture("server", html),
      capture("cold", html),
      capture("transition", html),
      "client",
      true,
      { minTextSimilarity: 0.98, minSourceTextLength: 10, compareLinks: true },
    );

    expect(findings.map((finding) => finding.ruleId)).toEqual(
      expect.arrayContaining([
        "RP301",
        "RP302",
        "RP303",
        "RP304",
        "RP305",
        "RP306",
        "RP307",
        "RP308",
      ]),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        ruleId: "RP301",
        message:
          "Title does not match the route contract for server HTML, the cold load, and in-app navigation.",
        actual: {
          server: ["Old page"],
          cold: ["Old page"],
          transition: ["Old page"],
        },
      }),
    );
  });

  it("names the one surface that breaks a route contract", () => {
    const expectedHtml = "<title>Page</title><main><h1>Page</h1><p>Useful content.</p></main>";
    const staleHtml = "<title>Old page</title><main><h1>Page</h1><p>Useful content.</p></main>";
    const findings = analyzeCaptures(
      { ...spec, expect: { title: "Page" } },
      capture("server", expectedHtml),
      capture("cold", expectedHtml),
      capture("transition", staleHtml),
      "client",
      true,
      { minTextSimilarity: 0.98, minSourceTextLength: 10, compareLinks: true },
    );

    expect(findings).toContainEqual(
      expect.objectContaining({
        ruleId: "RP301",
        phase: "transition",
        message: "Title does not match the route contract for in-app navigation.",
        expected: ["Page"],
        actual: ["Old page"],
      }),
    );
  });
});
