import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactText, redactUnknown } from "./redact.js";
import type { HttpEvidence, RuntimeEvent } from "./types.js";

export type ArtifactPhase = "source" | "cold" | "transition";

export interface SurfaceArtifact {
  phase: ArtifactPhase;
  screenshot?: Buffer | undefined;
  html?: string | undefined;
}

export interface RuntimeEvidence {
  surface: "cold" | "transition";
  runtime: RuntimeEvent[];
  http?: HttpEvidence | undefined;
}

export interface ArtifactBundle {
  surfaces: SurfaceArtifact[];
  runtimes: RuntimeEvidence[];
}

export function emptyArtifactBundle(): ArtifactBundle {
  return { surfaces: [], runtimes: [] };
}

export function transitionSlug(index: number, name: string): string {
  const label = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60)
    .replace(/(^-|-$)/g, "");
  return `${String(index + 1).padStart(2, "0")}-${label || "transition"}`;
}

export async function writeTransitionArtifacts(
  directory: string,
  slug: string,
  bundle: ArtifactBundle,
  secrets: string[],
): Promise<Record<string, string>> {
  const target = path.join(directory, slug);
  // Replace only RoutePlay's own evidence files; preserve other files in this directory.
  const names = ["source", "cold", "transition"].flatMap((phase) => [
    `${phase}.html`,
    `${phase}.png`,
  ]);
  for (const name of [...names, "runtime.json"]) {
    await rm(path.join(target, name), { force: true });
  }
  if (bundle.surfaces.length === 0 && bundle.runtimes.length === 0) return {};
  await mkdir(target, { recursive: true });
  const written: Record<string, string> = {};
  const record = (name: string): void => {
    written[name] = path.posix.join(slug, name);
  };

  for (const surface of bundle.surfaces) {
    if (surface.screenshot) {
      const name = `${surface.phase}.png`;
      await writeFile(path.join(target, name), surface.screenshot);
      record(name);
    }
    if (surface.html) {
      const name = `${surface.phase}.html`;
      await writeFile(path.join(target, name), redactText(surface.html, secrets), "utf8");
      record(name);
    }
  }

  if (bundle.runtimes.length > 0) {
    const payload = bundle.runtimes.map((entry) => ({
      surface: entry.surface,
      ...(entry.http ? { http: entry.http } : {}),
      events: entry.runtime,
    }));
    await writeFile(
      path.join(target, "runtime.json"),
      `${JSON.stringify(redactUnknown(payload, secrets), null, 2)}\n`,
      "utf8",
    );
    record("runtime.json");
  }

  return written;
}
