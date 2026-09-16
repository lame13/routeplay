import { type CheerioAPI, load } from "cheerio";
import { hashText, normalizeText } from "./similarity.js";
import type { SemanticSnapshot } from "./types.js";

export interface ExtractOptions {
  mainSelector?: string | undefined;
  ignoreSelectors?: string[] | undefined;
}

export const ignoredMainSelectors = [
  "script",
  "style",
  "template",
  "noscript",
  "svg",
  "[hidden]",
  '[aria-hidden="true"]',
] as const;

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function textValues($: CheerioAPI, selector: string, attribute?: string): string[] {
  return $(selector)
    .map((_index, element) =>
      normalizeText(attribute ? ($(element).attr(attribute) ?? "") : $(element).text()),
    )
    .get()
    .filter(Boolean);
}

function resolveUrls(values: string[], baseUrl: string, deduplicate = true): string[] {
  const resolved: string[] = [];
  for (const value of values) {
    try {
      resolved.push(new URL(value, baseUrl).href);
    } catch {
      // Invalid author-provided URLs stay out of semantic comparisons.
    }
  }
  const sorted = resolved.filter(Boolean).sort((left, right) => left.localeCompare(right));
  return deduplicate ? [...new Set(sorted)] : sorted;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function collectJsonLdTypes(value: unknown, output: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectJsonLdTypes(item, output);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  const type = record["@type"];
  if (typeof type === "string") output.push(type);
  if (Array.isArray(type)) {
    for (const item of type) if (typeof item === "string") output.push(item);
  }
  for (const nested of Object.values(record)) collectJsonLdTypes(nested, output);
}

function extractRobots($: CheerioAPI): Record<string, string[]> {
  const robots: Record<string, string[]> = {};
  $("meta[name][content]").each((_index, element) => {
    const name = ($(element).attr("name") ?? "").trim().toLocaleLowerCase();
    if (name !== "robots" && !name.endsWith("bot")) return;
    const tokens = ($(element).attr("content") ?? "")
      .split(/[,;]/)
      .map((token) => normalizeText(token).toLocaleLowerCase())
      .filter(Boolean);
    robots[name] = uniqueSorted([...(robots[name] ?? []), ...tokens]);
  });
  return Object.fromEntries(
    Object.entries(robots).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function extractSemantics(
  html: string,
  documentUrl: string,
  options: ExtractOptions = {},
): SemanticSnapshot {
  const $ = load(html);
  const baseHref = $("base[href]").first().attr("href");
  let resolutionBase = documentUrl;
  if (baseHref) {
    try {
      resolutionBase = new URL(baseHref, documentUrl).href;
    } catch {
      resolutionBase = documentUrl;
    }
  }

  const requestedMain = options.mainSelector ?? "main";
  const selector = $(requestedMain).length > 0 ? requestedMain : "body";
  const main = $(selector).first().clone();
  main.find([...ignoredMainSelectors, ...(options.ignoreSelectors ?? [])].join(",")).remove();
  const mainText = normalizeText(main.text());

  const linkValues: string[] = [];
  $("a[href]").each((_index, element) => {
    const href = $(element).attr("href");
    if (!href || /^(?:mailto|tel|javascript|data):/i.test(href)) return;
    try {
      const url = new URL(href, resolutionBase);
      if (!/^https?:$/.test(url.protocol) || url.origin !== new URL(documentUrl).origin) return;
      url.hash = "";
      linkValues.push(url.href);
    } catch {
      // Invalid hrefs are not crawlable links.
    }
  });

  const jsonLdTypes: string[] = [];
  const jsonLdFingerprints: string[] = [];
  let invalidJsonLd = 0;
  $('script[type="application/ld+json"]').each((_index, element) => {
    const content = $(element).text().trim();
    if (!content) return;
    try {
      const parsed = JSON.parse(content) as unknown;
      collectJsonLdTypes(parsed, jsonLdTypes);
      jsonLdFingerprints.push(hashText(stableJson(parsed)));
    } catch {
      invalidJsonLd += 1;
    }
  });

  return {
    url: documentUrl,
    titles: textValues($, "title"),
    descriptions: textValues($, 'meta[name="description" i][content]', "content"),
    canonicals: resolveUrls(
      textValues($, 'link[rel~="canonical" i][href]', "href"),
      resolutionBase,
      false,
    ),
    robots: extractRobots($),
    h1: textValues($, "h1"),
    jsonLdTypes: uniqueSorted(jsonLdTypes),
    jsonLdFingerprints: jsonLdFingerprints.sort((left, right) => left.localeCompare(right)),
    invalidJsonLd,
    main: {
      selector,
      text: mainText,
      hash: hashText(mainText),
      length: mainText.length,
    },
    links: uniqueSorted(linkValues),
    linkLikeWithoutHref: $("a:not([href]), [role='link']:not([href])").length,
  };
}
