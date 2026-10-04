import { describe, expect, it } from "vitest";
import { analyzeCaptures, baselineFindings, hreflangReciprocityFindings } from "../src/analyze.js";
import { extractSemantics } from "../src/extract.js";
import type { BaselineFile, Capture, TransitionSpec } from "../src/types.js";

const spec: TransitionSpec = {
  name: "Test",
  from: "https://example.test/",
  to: "https://example.test/page/",
  expectedFinalUrl: "https://example.test/page/",
  paths: [],
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

const settings = { minTextSimilarity: 0.98, minSourceTextLength: 10, compareLinks: true };

function baselineFrom(
  html: string,
  specHash = "hash",
  name = "Test",
): { baseline: BaselineFile; captures: Record<"server" | "cold" | "transition", Capture> } {
  const captures = {
    server: capture("server", html),
    cold: capture("cold", html),
    transition: capture("transition", html),
  };
  return {
    captures,
    baseline: {
      schemaVersion: 1,
      tool: { name: "routeplay", version: "0.5.0" },
      baseUrl: "https://example.test/",
      recordedAt: "2026-10-04T00:00:00.000Z",
      transitions: [
        {
          name,
          from: spec.from,
          to: spec.to,
          specHash,
          recordedAt: "2026-10-04T00:00:00.000Z",
          phases: {
            server: captures.server.semantic,
            cold: captures.cold.semantic,
            transition: captures.transition.semantic,
          },
        },
      ],
    },
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

  it("compares document language and hreflang alternates across surfaces", () => {
    const server = capture(
      "server",
      '<html lang="en"><title>Page</title><link rel="alternate" hreflang="en" href="/page/"><main><h1>Page</h1><p>Complete useful route content for visitors.</p></main>',
    );
    const cold = capture(
      "cold",
      '<html lang="th"><title>Page</title><link rel="alternate" hreflang="th" href="/page/"><main><h1>Page</h1><p>Complete useful route content for visitors.</p></main>',
    );
    const transition = capture(
      "transition",
      '<html lang="en"><title>Page</title><link rel="alternate" hreflang="en" href="/page/"><main><h1>Page</h1><p>Complete useful route content for visitors.</p></main>',
    );
    const findings = analyzeCaptures(spec, server, cold, transition, "client", true, settings);

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "RP501",
          comparison: "server-cold",
          severity: "warning",
        }),
        expect.objectContaining({
          ruleId: "RP501",
          comparison: "cold-transition",
          severity: "error",
        }),
        expect.objectContaining({ ruleId: "RP502", comparison: "cold-transition" }),
      ]),
    );
  });

  it("enforces a contract document language", () => {
    const html = '<html lang="en"><title>Page</title><main><h1>Page</h1></main>';
    const findings = analyzeCaptures(
      { ...spec, expect: { lang: "th" } },
      capture("server", html),
      capture("cold", html),
      capture("transition", html),
      "client",
      true,
      settings,
    );

    expect(findings).toContainEqual(
      expect.objectContaining({
        ruleId: "RP309",
        expected: ["th"],
        actual: {
          server: ["en"],
          cold: ["en"],
          transition: ["en"],
        },
      }),
    );
  });
});

describe("baselineFindings", () => {
  it("reports no drift when the run matches the recorded baseline", () => {
    const html = "<title>Page</title><main><h1>Page</h1><p>Complete recorded content.</p></main>";
    const { baseline, captures } = baselineFrom(html);
    expect(baselineFindings(spec, "hash", baseline, captures, settings)).toEqual([]);
  });

  it("reports baseline drift per surface with its own rule family", () => {
    const recorded =
      "<title>Page</title><main><h1>Page</h1><p>Complete recorded content.</p></main>";
    const drifted =
      "<title>Renamed</title><main><h1>Page</h1><p>Complete recorded content.</p></main>";
    const { baseline } = baselineFrom(recorded);
    const captures = {
      server: capture("server", recorded),
      cold: capture("cold", recorded),
      transition: capture("transition", drifted),
    };

    const findings = baselineFindings(spec, "hash", baseline, captures, settings);
    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: "RP402",
        comparison: "baseline-transition",
        severity: "error",
        expected: ["Page"],
        actual: ["Renamed"],
      }),
    ]);
  });

  it("flags missing and stale baseline entries instead of guessing", () => {
    const html = "<title>Page</title><main><h1>Page</h1><p>Complete recorded content.</p></main>";
    const { baseline, captures } = baselineFrom(html);

    const missing = baselineFindings(
      { ...spec, name: "Other", to: "https://example.test/other/" },
      "hash",
      baseline,
      captures,
      settings,
    );
    expect(missing).toEqual([expect.objectContaining({ ruleId: "RP400", severity: "warning" })]);

    const stale = baselineFindings(spec, "different-hash", baseline, captures, settings);
    expect(stale).toEqual([
      expect.objectContaining({
        ruleId: "RP400",
        severity: "warning",
        expected: "hash",
        actual: "different-hash",
      }),
    ]);
  });

  it("skips comparison entirely when no baseline is configured", () => {
    const html = "<title>Page</title><main><h1>Page</h1></main>";
    const { captures } = baselineFrom(html);
    expect(baselineFindings(spec, "hash", undefined, captures, settings)).toEqual([]);
  });
});

describe("hreflangReciprocityFindings", () => {
  const english = {
    to: "https://example.test/loc-en/",
    hreflangs: [
      { hreflang: "en", href: "https://example.test/loc-en/" },
      { hreflang: "th", href: "https://example.test/loc-th/" },
    ],
  };

  it("flags an alternate whose partner does not link back", () => {
    const findings = hreflangReciprocityFindings([
      english,
      {
        to: "https://example.test/loc-th/",
        hreflangs: [{ hreflang: "th", href: "https://example.test/loc-th/" }],
      },
    ]);
    expect(findings[0]).toEqual([
      expect.objectContaining({ ruleId: "RP503", severity: "warning" }),
    ]);
    expect(findings[1]).toEqual([]);
  });

  it("accepts reciprocal alternates and ignores unconfigured targets", () => {
    const reciprocal = hreflangReciprocityFindings([
      english,
      {
        to: "https://example.test/loc-th/",
        hreflangs: [
          { hreflang: "th", href: "https://example.test/loc-th/" },
          { hreflang: "en", href: "https://example.test/loc-en/" },
        ],
      },
    ]);
    expect(reciprocal).toEqual([[], []]);

    const unconfigured = hreflangReciprocityFindings([
      {
        to: "https://example.test/loc-en/",
        hreflangs: [{ hreflang: "fr", href: "https://example.test/loc-fr/" }],
      },
    ]);
    expect(unconfigured).toEqual([[]]);
  });
});
