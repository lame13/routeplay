import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { emptyArtifactBundle, transitionSlug, writeTransitionArtifacts } from "../src/artifacts.js";

describe("transitionSlug", () => {
  it("prefixes the configured index and normalizes the route name", () => {
    expect(transitionSlug(0, "Home → Pricing")).toBe("01-home-pricing");
    expect(transitionSlug(9, "  Ünïcode / Mess  ")).toBe("10-unicode-mess");
    expect(transitionSlug(2, "!!!")).toBe("03-transition");
  });

  it("keeps slugs unique for transitions that share a name", () => {
    expect(transitionSlug(0, "Same")).not.toBe(transitionSlug(1, "Same"));
  });
});

describe("writeTransitionArtifacts", () => {
  it("writes surfaces and runtime evidence with portable relative paths", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "routeplay-artifacts-"));
    const bundle = emptyArtifactBundle();
    bundle.surfaces.push({
      phase: "cold",
      html: "<main>Reflected token-secret value</main>",
      screenshot: Buffer.from("png-bytes"),
    });
    bundle.runtimes.push({
      surface: "cold",
      runtime: [{ kind: "page-error", message: "token-secret" }],
    });

    const written = await writeTransitionArtifacts(directory, "01-home-to-pricing", bundle, [
      "token-secret",
    ]);

    expect(written).toEqual({
      "cold.png": "01-home-to-pricing/cold.png",
      "cold.html": "01-home-to-pricing/cold.html",
      "runtime.json": "01-home-to-pricing/runtime.json",
    });
    const target = path.join(directory, "01-home-to-pricing");
    expect((await readdir(target)).sort()).toEqual(["cold.html", "cold.png", "runtime.json"]);
    expect(await readFile(path.join(target, "cold.html"), "utf8")).toContain("[REDACTED]");
    expect(await readFile(path.join(target, "runtime.json"), "utf8")).toContain("[REDACTED]");
    expect(await readFile(path.join(target, "cold.png"))).toEqual(Buffer.from("png-bytes"));
  });

  it("writes nothing when no evidence was collected", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "routeplay-artifacts-"));
    const written = await writeTransitionArtifacts(
      directory,
      "01-empty",
      emptyArtifactBundle(),
      [],
    );
    expect(written).toEqual({});
    expect(await readdir(directory)).toEqual([]);
  });

  it("redacts HTML-escaped credentials in text and attributes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "routeplay-artifacts-"));
    const bundle = emptyArtifactBundle();
    bundle.surfaces.push({
      phase: "cold",
      html: '<main data-secret="token&amp;&lt;&gt;&quot;">token&amp;&lt;&gt;"</main>',
    });
    await writeTransitionArtifacts(directory, "01-escaped", bundle, ['token&<>"']);
    expect(await readFile(path.join(directory, "01-escaped/cold.html"), "utf8")).toBe(
      '<main data-secret="[REDACTED]">[REDACTED]</main>',
    );
  });

  it("replaces earlier surface files when a failing run reuses the directory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "routeplay-artifacts-"));
    const bundle = emptyArtifactBundle();
    bundle.surfaces.push({ phase: "transition", html: "old", screenshot: Buffer.from("old") });
    await writeTransitionArtifacts(directory, "01-reused", bundle, []);
    await writeFile(path.join(directory, "01-reused/notes.txt"), "Keep user notes");
    bundle.surfaces = [{ phase: "cold", html: "new" }];
    await writeTransitionArtifacts(directory, "01-reused", bundle, []);
    expect((await readdir(path.join(directory, "01-reused"))).sort()).toEqual([
      "cold.html",
      "notes.txt",
    ]);
  });
});
