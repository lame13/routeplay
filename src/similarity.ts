import { createHash } from "node:crypto";

export function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function tokensFor(value: string): string[] {
  const normalized = normalizeText(value).toLocaleLowerCase();
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  return [...segmenter.segment(normalized)]
    .filter((segment) => segment.isWordLike)
    .map((segment) => segment.segment);
}

function characterShingles(value: string, size = 3): Set<string> {
  const characters = [...normalizeText(value).toLocaleLowerCase()];
  if (characters.length <= size) return new Set([characters.join("")].filter(Boolean));
  const result = new Set<string>();
  for (let index = 0; index <= characters.length - size; index += 1) {
    result.add(characters.slice(index, index + size).join(""));
  }
  return result;
}

function shingles(value: string, size = 3): Set<string> {
  const tokens = tokensFor(value);
  if (tokens.length < size) return characterShingles(value);
  const result = new Set<string>();
  for (let index = 0; index <= tokens.length - size; index += 1) {
    result.add(tokens.slice(index, index + size).join(" "));
  }
  return result;
}

export function textSimilarity(left: string, right: string): number {
  const a = shingles(left);
  const b = shingles(right);
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return (2 * intersection) / (a.size + b.size);
}
