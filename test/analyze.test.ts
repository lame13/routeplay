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
});
