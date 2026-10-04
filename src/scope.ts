import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SkippedTransition } from "./types.js";

const run = promisify(execFile);

/**
 * Glob support is intentionally small: `**` crosses directory boundaries, `*` and `?` stay inside
 * one path segment. Everything else is compared literally.
 */
export function matchGlob(pattern: string, file: string): boolean {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? "";
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          source += "(?:[^/]+/)*";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    source += character.replace(/[\\^$.|+()[\]{}]/g, (match) => `\\${match}`);
  }
  return new RegExp(`^${source}$`).test(file.replace(/^\.\//, ""));
}

export interface ChangeScopedTransition {
  name: string;
  to: string;
  paths: string[];
}

/**
 * Transitions without `paths` always run: a config that has not been annotated yet must not lose
 * coverage silently.
 */
export function selectTransitions<T extends ChangeScopedTransition>(
  transitions: T[],
  changedFiles: string[],
): { selected: T[]; skipped: SkippedTransition[] } {
  const selected: T[] = [];
  const skipped: SkippedTransition[] = [];
  for (const transition of transitions) {
    const scoped =
      transition.paths.length === 0 ||
      changedFiles.some((file) => transition.paths.some((pattern) => matchGlob(pattern, file)));
    if (scoped) selected.push(transition);
    else skipped.push({ name: transition.name, to: transition.to });
  }
  return { selected, skipped };
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

/**
 * Changed files relative to `base`, including untracked files, so a new page that has not been
 * committed yet still triggers its transitions.
 */
export async function changedFiles(options: { base: string; cwd?: string }): Promise<string[]> {
  const cwd = options.cwd ?? process.cwd();
  try {
    const root = (await git(["rev-parse", "--show-toplevel"], cwd)).trimEnd();
    const base = (
      await git(["rev-parse", "--verify", "--end-of-options", `${options.base}^{commit}`], root)
    ).trim();
    // No rename collapsing: both the old and new path can own a transition.
    const tracked = await git(["diff", "--name-only", "--no-renames", "-z", base, "--"], root);
    const untracked = await git(["ls-files", "--others", "--exclude-standard", "-z"], root);
    return [...new Set([...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean))].sort(
      (left, right) => left.localeCompare(right),
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not read changed files from Git for --diff-base ${options.base}. Run RoutePlay inside a Git checkout, or pass a ref that exists.\n${detail}`,
    );
  }
}
