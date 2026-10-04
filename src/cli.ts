import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Command, Option } from "commander";
import {
  baselineFromReport,
  DEFAULT_BASELINE_PATH,
  loadBaseline,
  mergeBaseline,
  readBaselineIfPresent,
  writeBaseline,
} from "./baseline.js";
import { launchBrowser } from "./browser.js";
import { defaultConfig, loadConfig, validateConfigFile } from "./config.js";
import { htmlReport } from "./reporters/html.js";
import { jsonReport } from "./reporters/json.js";
import { sarifReport } from "./reporters/sarif.js";
import { terminalReport } from "./reporters/terminal.js";
import { runRoutePlay, VERSION } from "./run.js";
import { changedFiles, selectTransitions } from "./scope.js";
import type { CheckOptions, RoutePlayReport } from "./types.js";

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

interface CliCheckOptions
  extends Omit<
    CheckOptions,
    "configPath" | "headers" | "concurrency" | "retries" | "repeat" | "updateBaseline"
  > {
  config?: string;
  header?: string[];
  concurrency?: string;
  retries?: string;
  repeat?: string;
  updateBaseline?: string | boolean;
}

function countOption(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${label} expects a whole number, received "${value}".`);
  }
  return parsed;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function render(report: RoutePlayReport, format: NonNullable<CheckOptions["format"]>): string {
  if (format === "json") return jsonReport(report);
  if (format === "html") return htmlReport(report);
  if (format === "sarif") return sarifReport(report);
  return terminalReport(report);
}

async function writeOutput(output: string, contents: string): Promise<void> {
  const absolute = path.resolve(output);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, contents, "utf8");
  process.stderr.write(`Report written to ${absolute}\n`);
}

async function resolveConfigPath(options: CheckOptions): Promise<CheckOptions> {
  const defaultPath = path.resolve("routeplay.config.json");
  if (options.configPath || options.baseUrl || !(await fileExists(defaultPath))) return options;
  return { ...options, configPath: defaultPath };
}

async function applyChangeScope(
  options: CheckOptions,
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<void> {
  if (!options.onlyChanged) return;
  if (!options.diffBase) {
    throw new Error(
      "--only-changed requires --diff-base <git-ref>, for example --diff-base origin/main.",
    );
  }
  const files = await changedFiles({ base: options.diffBase });
  const { selected, skipped } = selectTransitions(config.transitions, files);
  config.transitions = selected;
  config.scope = { diffBase: options.diffBase, changedFiles: files, skipped };
  if (selected.length === 0) {
    process.stderr.write(
      `RoutePlay: no configured transition matched ${files.length} changed file(s) since ${options.diffBase}.\n`,
    );
  }
}

async function check(options: CheckOptions): Promise<void> {
  const config = await loadConfig(await resolveConfigPath(options));
  await applyChangeScope(options, config);
  if (options.baseline && options.updateBaseline === undefined) {
    config.baseline = await loadBaseline(options.baseline);
  }
  const report = await runRoutePlay(config);
  if (options.updateBaseline !== undefined) {
    const target =
      options.updateBaseline || options.baseline || path.resolve(DEFAULT_BASELINE_PATH);
    const { baseline: fresh, skipped } = baselineFromReport(report, config);
    const merged = mergeBaseline(await readBaselineIfPresent(target), fresh);
    const written = await writeBaseline(target, merged.baseline, config);
    process.stderr.write(
      `Baseline updated: ${written} (${fresh.transitions.length} recorded, ${merged.replaced} replaced, ${merged.retained} retained)\n`,
    );
    if (skipped.length > 0) {
      process.stderr.write(
        `RoutePlay: incomplete transitions were not recorded: ${skipped.join(", ")}\n`,
      );
    }
  }
  const format = options.format ?? "terminal";
  const contents = render(report, format);
  if (options.output) await writeOutput(options.output, `${contents}\n`);
  else process.stdout.write(`${contents}\n`);
  process.exitCode = report.summary.incomplete > 0 ? 2 : report.passed ? 0 : 1;
}

async function snapshot(options: CheckOptions & { output?: string }): Promise<void> {
  const config = await loadConfig(await resolveConfigPath(options));
  const report = await runRoutePlay(config);
  const { baseline, skipped } = baselineFromReport(report, config);
  if (baseline.transitions.length === 0) {
    throw new Error("No transition could be captured, so no baseline was written.");
  }
  if (skipped.length > 0) {
    throw new Error(
      `No baseline was written because these transitions were incomplete: ${skipped.join(", ")}.`,
    );
  }
  const written = await writeBaseline(options.output ?? DEFAULT_BASELINE_PATH, baseline, config);
  process.stdout.write(`${terminalReport(report)}\n`);
  process.stdout.write(
    `\nRecorded ${baseline.transitions.length} transition(s) in ${written}\nFrozen findings: ${report.summary.errors} error(s), ${report.summary.warnings} warning(s). Future runs compare against this state.\n`,
  );
}

async function initConfig(file: string, force: boolean): Promise<void> {
  const absolute = path.resolve(file);
  if (!force && (await fileExists(absolute))) {
    throw new Error(`${absolute} already exists. Use --force to replace it.`);
  }
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(defaultConfig, null, 2)}\n`, "utf8");
  process.stdout.write(`Created ${absolute}\n`);
}

async function validateConfig(file: string): Promise<void> {
  const { path: absolute, transitionCount: transitions } = await validateConfigFile(file);
  process.stdout.write(
    `Valid RoutePlay config: ${absolute} (${transitions} transition${transitions === 1 ? "" : "s"})\n`,
  );
}

async function doctor(configPath?: string): Promise<void> {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (major < 22) throw new Error(`Node.js 22+ is required; found ${process.versions.node}.`);
  if (configPath) await loadConfig({ configPath });
  const browser = await launchBrowser();
  const version = browser.version();
  await browser.close();
  process.stdout.write(
    `RoutePlay ${VERSION}\nNode.js ${process.versions.node}\nChromium ${version}\nReady\n`,
  );
}

async function installChromium(): Promise<void> {
  const require = createRequire(import.meta.url);
  const cli = path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "install", "chromium"], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Playwright installer exited ${code}.`)),
    );
  });
}

export async function main(argv = process.argv): Promise<void> {
  const program = new Command()
    .name("routeplay")
    .description(
      "Compare SSR route semantics across server HTML, cold loads, and real in-app navigation.",
    )
    .version(VERSION)
    .showHelpAfterError();

  program
    .command("check")
    .description("Run configured route-transition parity checks")
    .option("-c, --config <path>", "JSON config path")
    .option("--base-url <url>", "base URL for one-off mode")
    .option("--from <path-or-url>", "source route for one-off mode")
    .option("--to <path-or-url>", "destination route for one-off mode")
    .option("--selector <css>", "exact anchor selector for one-off mode")
    .option("--header <name=value>", "origin-scoped request header; repeatable", collect, [])
    .option("--concurrency <count>", "transitions to capture at once, 1-8")
    .option("--retries <count>", "extra attempts for failing transitions, 0-3")
    .option("--repeat <count>", "captures per transition for instability detection, 1-5")
    .option("--artifacts <dir>", "write screenshots, DOM, and runtime events for failures")
    .option("--storage-state <path>", "Playwright storage state file for authenticated routes")
    .option("--baseline <path>", "compare the run against a recorded baseline")
    .option(
      "--update-baseline [path]",
      "rewrite the baseline from this run instead of comparing against it",
    )
    .option("--only-changed", "run only transitions whose configured paths changed")
    .option("--diff-base <ref>", "Git ref used by --only-changed")
    .addOption(
      new Option("--fail-on <level>", "failure threshold").choices(["error", "warning", "never"]),
    )
    .addOption(
      new Option("-f, --format <format>", "report format")
        .choices(["terminal", "json", "html", "sarif"])
        .default("terminal"),
    )
    .option("-o, --output <path>", "write the report to a file")
    .action(async (options: CliCheckOptions) => {
      const { config, header, concurrency, retries, repeat, updateBaseline, ...rest } = options;
      const concurrencyCount = countOption(concurrency, "--concurrency");
      const retryCount = countOption(retries, "--retries");
      const repeatCount = countOption(repeat, "--repeat");
      await check({
        ...rest,
        ...(config ? { configPath: config } : {}),
        ...(header ? { headers: header } : {}),
        ...(concurrencyCount === undefined ? {} : { concurrency: concurrencyCount }),
        ...(retryCount === undefined ? {} : { retries: retryCount }),
        ...(repeatCount === undefined ? {} : { repeat: repeatCount }),
        ...(typeof updateBaseline === "string" || updateBaseline === true
          ? { updateBaseline: updateBaseline === true ? "" : updateBaseline }
          : {}),
      });
    });

  program
    .command("snapshot")
    .description("Record the current route behavior as the baseline future runs compare against")
    .option("-c, --config <path>", "JSON config path")
    .option("--base-url <url>", "base URL for one-off mode")
    .option("--from <path-or-url>", "source route for one-off mode")
    .option("--to <path-or-url>", "destination route for one-off mode")
    .option("--selector <css>", "exact anchor selector for one-off mode")
    .option("--header <name=value>", "origin-scoped request header; repeatable", collect, [])
    .option("--storage-state <path>", "Playwright storage state file for authenticated routes")
    .option("--artifacts <dir>", "write screenshots, DOM, and runtime events for failures")
    .option("-o, --output <path>", "baseline file to write", DEFAULT_BASELINE_PATH)
    .action(
      async (options: {
        config?: string;
        header?: string[];
        output?: string;
        baseUrl?: string;
        from?: string;
        to?: string;
        selector?: string;
        storageState?: string;
        artifacts?: string;
      }) => {
        const { config, header, ...rest } = options;
        await snapshot({
          ...rest,
          ...(config ? { configPath: config } : {}),
          ...(header ? { headers: header } : {}),
        });
      },
    );

  program
    .command("init")
    .description("Create a documented starter config")
    .argument("[path]", "output path", "routeplay.config.json")
    .option("--force", "replace an existing file", false)
    .action(async (file: string, options: { force: boolean }) => initConfig(file, options.force));

  program
    .command("validate")
    .description("Validate a config without launching Chromium")
    .argument("[path]", "config path", "routeplay.config.json")
    .action(validateConfig);

  program
    .command("doctor")
    .description("Validate Node.js, optional config, and the Chromium installation")
    .option("-c, --config <path>", "also validate this config")
    .action(async (options: { config?: string }) => doctor(options.config));

  program
    .command("install")
    .description("Install RoutePlay's matching Chromium build")
    .action(installChromium);

  await program.parseAsync(argv);
}

main().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`RoutePlay: ${message}\n`);
  if (process.env.ROUTEPLAY_DEBUG === "1" && error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exitCode = 2;
});
