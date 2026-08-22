import { describe, expect, it } from "vitest";
import { extractSemantics } from "../src/extract.js";
import { textSimilarity } from "../src/similarity.js";

describe("extractSemantics", () => {
  it("extracts normalized SEO semantics and crawlable links", () => {
    const snapshot = extractSemantics(
      `<!doctype html><html><head>
        <base href="/docs/">
        <title>  Useful   page </title>
        <meta name="description" content="A useful page">
        <meta name="robots" content="INDEX, follow">
        <link rel="canonical" href="guide/">
        <script type="application/ld+json">{"@type":["Article","TechArticle"]}</script>
      </head><body><main><h1> Guide </h1><p>Hello <time>today</time> world.</p>
        <a href="next/">Next</a><a>Broken</a><span role="link">Also broken</span>
      </main></body></html>`,
      "https://example.test/start/",
      { ignoreSelectors: ["time"] },
    );
    expect(snapshot.titles).toEqual(["Useful page"]);
    expect(snapshot.canonicals).toEqual(["https://example.test/docs/guide/"]);
    expect(snapshot.robots).toEqual({ robots: ["follow", "index"] });
    expect(snapshot.h1).toEqual(["Guide"]);
    expect(snapshot.main.text).toContain("Hello world.");
    expect(snapshot.links).toEqual(["https://example.test/docs/next/"]);
    expect(snapshot.jsonLdTypes).toEqual(["Article", "TechArticle"]);
    expect(snapshot.linkLikeWithoutHref).toBe(2);
  });

  it("reports invalid JSON-LD without throwing", () => {
    const snapshot = extractSemantics(
      '<main>Text</main><script type="application/ld+json">{bad}</script>',
      "https://example.test/",
    );
    expect(snapshot.invalidJsonLd).toBe(1);
  });

  it("preserves duplicate canonicals and JSON-LD blocks as parity evidence", () => {
    const snapshot = extractSemantics(
      `<link rel="canonical" href="/page/"><link rel="canonical" href="/page/">
       <script type="application/ld+json">{"name":"One","@type":"Article"}</script>
       <script type="application/ld+json">{"@type":"Article","name":"One"}</script>`,
      "https://example.test/page/",
    );
    expect(snapshot.canonicals).toEqual([
      "https://example.test/page/",
      "https://example.test/page/",
    ]);
    expect(snapshot.jsonLdFingerprints).toHaveLength(2);
    expect(snapshot.jsonLdFingerprints[0]).toBe(snapshot.jsonLdFingerprints[1]);
  });
});

describe("textSimilarity", () => {
  it("ignores whitespace and measures changed word shingles", () => {
    expect(textSimilarity("one   two three four", "one two three four")).toBe(1);
    expect(textSimilarity("one two three four", "completely different copy here")).toBe(0);
  });
});
