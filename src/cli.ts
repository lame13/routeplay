import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Command, Option } from "commander";
import { launchBrowser } from "./browser.js";
import { defaultConfig, loadConfig, validateConfigFile } from "./config.js";
import { htmlReport } from "./reporters/html.js";
import { jsonReport } from "./reporters/json.js";
import { sarifReport } from "./reporters/sarif.js";
import { terminalReport } from "./reporters/terminal.js";
import { runRoutePlay, VERSION } from "./run.js";
import type { CheckOptions, RoutePlayReport } from "./types.js";

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

interface CliCheckOptions
  extends Omit<CheckOptions, "configPath" | "headers" | "concurrency" | "retries"> {
  config?: string;
  header?: string[];
  concurrency?: string;
  retries?: string;
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

async function check(options: CheckOptions): Promise<void> {
  const defaultPath = path.resolve("routeplay.config.json");
  const resolvedOptions = {
    ...options,
    ...(!options.configPath && !options.baseUrl && (await fileExists(defaultPath))
      ? { configPath: defaultPath }
      : {}),
  };
  const config = await loadConfig(resolvedOptions);
  const report = await runRoutePlay(config);
  const format = options.format ?? "terminal";
  const contents = render(report, format);
  if (options.output) await writeOutput(options.output, `${contents}\n`);
  else process.stdout.write(`${contents}\n`);
  process.exitCode = report.summary.incomplete > 0 ? 2 : report.passed ? 0 : 1;
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
    .option("--artifacts <dir>", "write screenshots, DOM, and runtime events for failures")
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
      const { config, header, concurrency, retries, ...rest } = options;
      const concurrencyCount = countOption(concurrency, "--concurrency");
      const retryCount = countOption(retries, "--retries");
      await check({
        ...rest,
        ...(config ? { configPath: config } : {}),
        ...(header ? { headers: header } : {}),
        ...(concurrencyCount === undefined ? {} : { concurrency: concurrencyCount }),
        ...(retryCount === undefined ? {} : { retries: retryCount }),
      });
    });

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
