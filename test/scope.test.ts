import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { changedFiles, matchGlob, selectTransitions } from "../src/scope.js";

const run = promisify(execFile);

describe("matchGlob", () => {
  it("keeps a single star inside one path segment", () => {
    expect(matchGlob("app/*.tsx", "app/page.tsx")).toBe(true);
    expect(matchGlob("app/*.tsx", "app/blog/page.tsx")).toBe(false);
  });

  it("lets a double star cross directories", () => {
    expect(matchGlob("app/**", "app/blog/page.tsx")).toBe(true);
    expect(matchGlob("**/*.tsx", "app/blog/page.tsx")).toBe(true);
    expect(matchGlob("**/*.tsx", "app/page.tsx")).toBe(true);
    expect(matchGlob("**/*.tsx", "app/page.ts")).toBe(false);
  });

  it("supports single-character wildcards and literal dots", () => {
    expect(matchGlob("content/post-?.md", "content/post-1.md")).toBe(true);
    expect(matchGlob("content/post-?.md", "content/post-12.md")).toBe(false);
    expect(matchGlob("src/index.ts", "./src/index.ts")).toBe(true);
    expect(matchGlob("src/indexXts", "src/index.ts")).toBe(false);
  });
});

describe("selectTransitions", () => {
  const transitions = [
    { name: "Annotated", to: "https://example.test/blog/", paths: ["app/blog/**"] },
    { name: "Unannotated", to: "https://example.test/pricing/", paths: [] },
  ];

  it("keeps transitions without paths so coverage is never lost silently", () => {
    const { selected, skipped } = selectTransitions(transitions, ["README.md"]);
    expect(selected.map((transition) => transition.name)).toEqual(["Unannotated"]);
    expect(skipped).toEqual([{ name: "Annotated", to: "https://example.test/blog/" }]);
  });

  it("selects annotated transitions whose paths changed", () => {
    const { selected, skipped } = selectTransitions(transitions, ["app/blog/page.tsx"]);
    expect(selected.map((transition) => transition.name)).toEqual(["Annotated", "Unannotated"]);
    expect(skipped).toEqual([]);
  });
});

describe("changedFiles", () => {
  it("keeps both renamed paths and exact filenames, including from a subdirectory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "routeplay-scope-"));
    await run("git", ["init", "-q"], { cwd: directory });
    await run("git", ["config", "user.email", "test@example.test"], { cwd: directory });
    await run("git", ["config", "user.name", "RoutePlay Test"], { cwd: directory });
    await mkdir(path.join(directory, "app"));
    await writeFile(path.join(directory, "old.ts"), "old contents");
    const unusual = "app/ไทย\n page.ts";
    await writeFile(path.join(directory, unusual), "before");
    await run("git", ["add", "."], { cwd: directory });
    await run("git", ["commit", "-qm", "initial"], { cwd: directory });
    await rename(path.join(directory, "old.ts"), path.join(directory, "app/new.ts"));
    await run("git", ["add", "."], { cwd: directory });
    await writeFile(path.join(directory, unusual), "after");
    await writeFile(path.join(directory, " outside.ts "), "untracked");
    const files = await changedFiles({ base: "HEAD", cwd: path.join(directory, "app") });
    expect(files).toHaveLength(4);
    expect(files).toEqual(
      expect.arrayContaining(["old.ts", "app/new.ts", unusual, " outside.ts "]),
    );
    await expect(changedFiles({ base: "--stat", cwd: directory })).rejects.toThrow(
      "Could not read changed files",
    );
  });
  it("lists tracked and untracked changes relative to a ref", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "routeplay-scope-"));
    await run("git", ["init", "-q"], { cwd: directory });
    await run("git", ["config", "user.email", "test@example.test"], { cwd: directory });
    await run("git", ["config", "user.name", "RoutePlay Test"], { cwd: directory });
    await mkdir(path.join(directory, "app/blog"), { recursive: true });
    await writeFile(path.join(directory, "app/blog/page.tsx"), "export default 1;\n");
    await run("git", ["add", "."], { cwd: directory });
    await run("git", ["commit", "-qm", "initial"], { cwd: directory });
    await writeFile(path.join(directory, "app/blog/page.tsx"), "export default 2;\n");
    await writeFile(path.join(directory, "app/blog/new.tsx"), "export default 3;\n");

    expect(await changedFiles({ base: "HEAD", cwd: directory })).toEqual([
      "app/blog/new.tsx",
      "app/blog/page.tsx",
    ]);
  });

  it("fails with a helpful message for an unknown ref", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "routeplay-scope-"));
    await run("git", ["init", "-q"], { cwd: directory });
    await expect(changedFiles({ base: "missing-ref", cwd: directory })).rejects.toThrow(
      "Could not read changed files from Git",
    );
  });
});
