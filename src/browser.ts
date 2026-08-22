import { randomUUID } from "node:crypto";
import { type Browser, type BrowserContext, chromium, type Page, type Request } from "playwright";
import { analyzeCaptures } from "./analyze.js";
import { extractSemantics } from "./extract.js";
import type {
  Capture,
  HttpEvidence,
  NavigationMode,
  RoutePlayConfig,
  RuntimeEvent,
  TransitionResult,
  TransitionSpec,
} from "./types.js";

export class RoutePlayCaptureError extends Error {
  public constructor(
    public readonly ruleId: "RP001" | "RP002" | "RP003",
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "RoutePlayCaptureError";
  }
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function importantRequest(request: Request): boolean {
  return ["document", "script", "stylesheet", "xhr", "fetch"].includes(request.resourceType());
}

async function createContext(browser: Browser, config: RoutePlayConfig): Promise<BrowserContext> {
  return browser.newContext({
    locale: config.browser.locale,
    timezoneId: config.browser.timezoneId,
    viewport: config.browser.viewport,
    serviceWorkers: "block",
    reducedMotion: "reduce",
    colorScheme: "light",
    ...(config.browser.userAgent ? { userAgent: config.browser.userAgent } : {}),
  });
}

interface PausedRequest {
  requestId: string;
  request: { url: string; headers: Record<string, string> };
}

async function installOriginHeaders(
  context: BrowserContext,
  page: Page,
  auditedOrigin: string,
  configuredHeaders: Record<string, string>,
): Promise<void> {
  if (Object.keys(configuredHeaders).length === 0) return;
  const session = await context.newCDPSession(page);
  const configuredNames = new Set(Object.keys(configuredHeaders).map((name) => name.toLowerCase()));
  await session.send("Fetch.enable", {
    patterns: [{ urlPattern: "*", requestStage: "Request" }],
  });
  session.on("Fetch.requestPaused", (event) => {
    const paused = event as PausedRequest;
    const headers = Object.entries(paused.request.headers)
      .filter(([name]) => !configuredNames.has(name.toLowerCase()))
      .map(([name, value]) => ({ name, value }));
    if (sameOrigin(paused.request.url, auditedOrigin)) {
      headers.push(...Object.entries(configuredHeaders).map(([name, value]) => ({ name, value })));
    }
    void session
      .send("Fetch.continueRequest", { requestId: paused.requestId, headers })
      .catch(() => {
        void session.send("Fetch.failRequest", {
          requestId: paused.requestId,
          errorReason: "Failed",
        });
      });
  });
}

function attachDiagnostics(page: Page, auditedOrigin: string, events: RuntimeEvent[]): void {
  page.on("pageerror", (error) => {
    events.push({ kind: "page-error", message: error.message });
  });
  page.on("console", (message) => {
    if (message.type() === "error") events.push({ kind: "console-error", message: message.text() });
  });
  page.on("requestfailed", (request) => {
    events.push({
      kind: "request-failed",
      message: `${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "request failed"}`,
      url: request.url(),
      sameOrigin: sameOrigin(request.url(), auditedOrigin) && importantRequest(request),
    });
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const request = response.request();
    events.push({
      kind: "http-error",
      message: `${response.status()} ${request.method()} ${response.url()}`,
      url: response.url(),
      status: response.status(),
      sameOrigin: sameOrigin(response.url(), auditedOrigin) && importantRequest(request),
    });
  });
}

function redirectChain(request: Request): string[] {
  const chain: string[] = [];
  let current: Request | null = request;
  while (current) {
    chain.unshift(current.url());
    current = current.redirectedFrom();
  }
  return chain;
}

async function waitForStable(
  page: Page,
  spec: TransitionSpec,
  config: RoutePlayConfig,
  useReadySelector = true,
): Promise<void> {
  const deadline = Date.now() + config.browser.timeoutMs;
  if (useReadySelector && spec.mainSelector) {
    await page.waitForSelector(spec.mainSelector, {
      state: "attached",
      timeout: config.browser.timeoutMs,
    });
  }
  if (useReadySelector && spec.readySelector) {
    await page.waitForSelector(spec.readySelector, {
      state: "attached",
      timeout: config.browser.timeoutMs,
    });
  }
  await page
    .waitForLoadState("load", { timeout: Math.min(config.browser.timeoutMs, 5_000) })
    .catch(() => {});

  let previous = "";
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const semantics = extractSemantics(await page.content(), page.url(), {
      mainSelector: spec.mainSelector,
      ignoreSelectors: spec.ignoreSelectors,
    });
    const signature = JSON.stringify({
      url: semantics.url,
      titles: semantics.titles,
      descriptions: semantics.descriptions,
      canonicals: semantics.canonicals,
      robots: semantics.robots,
      h1: semantics.h1,
      jsonLdFingerprints: semantics.jsonLdFingerprints,
      invalidJsonLd: semantics.invalidJsonLd,
      main: semantics.main.hash,
      ...(config.compare.compareLinks ? { links: semantics.links } : {}),
    });
    if (signature !== previous) {
      previous = signature;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= config.browser.settleMs) {
      return;
    }
    await page.waitForTimeout(100);
  }
  throw new RoutePlayCaptureError(
    "RP001",
    `Route did not reach semantic stability within ${config.browser.timeoutMs}ms.`,
    "Use readySelector or increase browser.timeoutMs for data-heavy routes.",
  );
}

async function captureDirect(
  browser: Browser,
  spec: TransitionSpec,
  config: RoutePlayConfig,
): Promise<{ server: Capture; cold: Capture }> {
  const context = await createContext(browser, config);
  const page = await context.newPage();
  const runtime: RuntimeEvent[] = [];
  await installOriginHeaders(context, page, new URL(config.baseUrl).origin, config.headers);
  attachDiagnostics(page, new URL(config.baseUrl).origin, runtime);
  try {
    const response = await page.goto(spec.to, {
      waitUntil: "domcontentloaded",
      timeout: config.browser.timeoutMs,
    });
    if (!response) throw new RoutePlayCaptureError("RP001", `No document response for ${spec.to}.`);
    const body = await response.text();
    const responseHeaders = await response.allHeaders();
    const http: HttpEvidence = {
      requestedUrl: spec.to,
      responseUrl: response.url(),
      status: response.status(),
      contentType: responseHeaders["content-type"] ?? "",
      redirects: redirectChain(response.request()),
      xRobotsTag: responseHeaders["x-robots-tag"]
        ? responseHeaders["x-robots-tag"].split(/,(?=\s*[a-z-]+:)/i).map((value) => value.trim())
        : [],
    };
    if (!http.contentType.toLocaleLowerCase().includes("text/html")) {
      throw new RoutePlayCaptureError(
        "RP001",
        `Expected HTML from ${spec.to}, received ${http.contentType || "an unknown content type"}.`,
      );
    }
    const server: Capture = {
      phase: "server",
      http,
      runtime: [],
      semantic: extractSemantics(body, response.url(), {
        mainSelector: spec.mainSelector,
        ignoreSelectors: spec.ignoreSelectors,
      }),
    };
    await waitForStable(page, spec, config);
    const cold: Capture = {
      phase: "cold",
      http,
      runtime: runtime.filter(
        (event) =>
          !(
            event.kind === "http-error" &&
            event.status === spec.expectedStatus &&
            event.url === response.url()
          ),
      ),
      semantic: extractSemantics(await page.content(), page.url(), {
        mainSelector: spec.mainSelector,
        ignoreSelectors: spec.ignoreSelectors,
      }),
    };
    return { server, cold };
  } finally {
    await context.close();
  }
}

function comparableUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.href;
}

async function findAnchor(
  page: Page,
  spec: TransitionSpec,
  acceptedUrls: string[],
): Promise<{ index: number; href: string }> {
  const targets = acceptedUrls.map(comparableUrl);
  if (spec.selector) {
    const candidate = page.locator(spec.selector).first();
    if ((await candidate.count()) === 0) {
      throw new RoutePlayCaptureError("RP002", `No element matches selector ${spec.selector}.`);
    }
    const details = await candidate.evaluate((element) => ({
      tag: element.tagName,
      href: element instanceof HTMLAnchorElement ? element.href : "",
      target: element instanceof HTMLAnchorElement ? element.target : "",
      download: element instanceof HTMLAnchorElement && element.hasAttribute("download"),
    }));
    if (details.tag !== "A" || !details.href || details.target === "_blank" || details.download) {
      throw new RoutePlayCaptureError(
        "RP002",
        `Selector ${spec.selector} must resolve to a same-tab <a href> without download.`,
      );
    }
    if (new URL(details.href).origin !== new URL(spec.to).origin) {
      throw new RoutePlayCaptureError("RP002", `Selector ${spec.selector} resolves cross-origin.`);
    }
    return { index: -1, href: details.href };
  }

  const details = await page.locator("a[href]").evaluateAll((elements, expected) => {
    const index = elements.findIndex((element) => {
      if (!(element instanceof HTMLAnchorElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const href = new URL(element.href);
      href.hash = "";
      return (
        expected.includes(href.href) &&
        element.target !== "_blank" &&
        !element.hasAttribute("download") &&
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    });
    return { index, href: index >= 0 ? (elements[index] as HTMLAnchorElement).href : "" };
  }, targets);
  if (details.index < 0) {
    throw new RoutePlayCaptureError(
      "RP002",
      `No visible same-origin <a href> from ${spec.from} to ${spec.to}.`,
      "Set selector when multiple URLs or localized links resolve differently.",
    );
  }
  return details;
}

async function captureTransition(
  browser: Browser,
  spec: TransitionSpec,
  config: RoutePlayConfig,
  coldFinalUrl: string,
): Promise<{
  capture: Capture;
  mode: NavigationMode;
  anchorHref: string;
  sourceUrl: string;
  sourceLinkInServer: boolean;
  documentRequestUrl?: string;
}> {
  const context = await createContext(browser, config);
  const page = await context.newPage();
  const runtime: RuntimeEvent[] = [];
  await installOriginHeaders(context, page, new URL(config.baseUrl).origin, config.headers);
  attachDiagnostics(page, new URL(config.baseUrl).origin, runtime);
  try {
    const sourceResponse = await page.goto(spec.from, {
      waitUntil: "domcontentloaded",
      timeout: config.browser.timeoutMs,
    });
    if (!sourceResponse) {
      throw new RoutePlayCaptureError("RP001", `No source document response for ${spec.from}.`);
    }
    if (sourceResponse.status() >= 400) {
      throw new RoutePlayCaptureError(
        "RP001",
        `Source route ${spec.from} returned HTTP ${sourceResponse.status()}.`,
      );
    }
    const sourceHeaders = await sourceResponse.allHeaders();
    if (!(sourceHeaders["content-type"] ?? "").toLocaleLowerCase().includes("text/html")) {
      throw new RoutePlayCaptureError("RP001", `Source route ${spec.from} did not return HTML.`);
    }
    const acceptedUrls = [spec.to, spec.expectedFinalUrl, coldFinalUrl];
    const sourceSemantics = extractSemantics(await sourceResponse.text(), sourceResponse.url());
    const sourceLinkInServer = sourceSemantics.links.some((link) =>
      acceptedUrls.map(comparableUrl).includes(comparableUrl(link)),
    );
    await waitForStable(page, spec, config, false);
    const anchor = await findAnchor(page, spec, acceptedUrls);
    const documentId = randomUUID();
    await page.evaluate((id) => {
      (window as Window & { __routeplayDocumentId?: string }).__routeplayDocumentId = id;
    }, documentId);
    runtime.length = 0;
    let documentRequestUrl: string | undefined;
    page.on("request", (request) => {
      if (request.isNavigationRequest() && request.resourceType() === "document") {
        documentRequestUrl = request.url();
      }
    });

    const locator = spec.selector
      ? page.locator(spec.selector).first()
      : page.locator("a[href]").nth(anchor.index);
    await locator.click({ timeout: config.browser.timeoutMs });
    await page
      .waitForURL((url) => acceptedUrls.map(comparableUrl).includes(comparableUrl(url.href)), {
        timeout: config.browser.timeoutMs,
      })
      .catch(() => {});
    if (!acceptedUrls.map(comparableUrl).includes(comparableUrl(page.url()))) {
      throw new RoutePlayCaptureError(
        "RP003",
        `Click did not reach ${spec.to}; current URL is ${page.url()}.`,
      );
    }
    await waitForStable(page, spec, config);
    const survivingId = await page.evaluate(
      () => (window as Window & { __routeplayDocumentId?: string }).__routeplayDocumentId,
    );
    const mode: NavigationMode =
      survivingId === documentId ? "client" : documentRequestUrl ? "document" : "unknown";
    const capture: Capture = {
      phase: "transition",
      runtime: runtime.filter(
        (event) =>
          !(
            event.kind === "http-error" &&
            event.status === spec.expectedStatus &&
            event.url !== undefined &&
            comparableUrl(event.url) === comparableUrl(page.url())
          ),
      ),
      semantic: extractSemantics(await page.content(), page.url(), {
        mainSelector: spec.mainSelector,
        ignoreSelectors: spec.ignoreSelectors,
      }),
    };
    return {
      capture,
      mode,
      anchorHref: anchor.href,
      sourceUrl: sourceResponse.url(),
      sourceLinkInServer,
      ...(documentRequestUrl ? { documentRequestUrl } : {}),
    };
  } finally {
    await context.close();
  }
}

export async function runTransition(
  browser: Browser,
  spec: TransitionSpec,
  config: RoutePlayConfig,
): Promise<TransitionResult> {
  const started = Date.now();
  try {
    const direct = await captureDirect(browser, spec, config);
    const warm = await captureTransition(browser, spec, config, direct.cold.semantic.url);
    const findings = analyzeCaptures(
      spec,
      direct.server,
      direct.cold,
      warm.capture,
      warm.mode,
      warm.sourceLinkInServer,
      config.compare,
    );
    return {
      name: spec.name,
      from: spec.from,
      to: spec.to,
      navigation: {
        mode: warm.mode,
        anchorHref: warm.anchorHref,
        sourceUrl: warm.sourceUrl,
        sourceLinkInServer: warm.sourceLinkInServer,
        ...(warm.documentRequestUrl ? { documentRequestUrl: warm.documentRequestUrl } : {}),
      },
      captures: { server: direct.server, cold: direct.cold, transition: warm.capture },
      findings,
      durationMs: Date.now() - started,
      complete: true,
    };
  } catch (error) {
    const captureError = error instanceof RoutePlayCaptureError ? error : null;
    return {
      name: spec.name,
      from: spec.from,
      to: spec.to,
      navigation: { mode: "unknown" },
      findings: [
        {
          ruleId: captureError?.ruleId ?? "RP001",
          severity: "error",
          message:
            captureError?.message ?? (error instanceof Error ? error.message : String(error)),
          ...(captureError?.hint ? { hint: captureError.hint } : {}),
        },
      ],
      durationMs: Date.now() - started,
      complete: false,
    };
  }
}

export async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({
      headless: true,
      ...(process.env.ROUTEPLAY_CHROMIUM_PATH
        ? { executablePath: process.env.ROUTEPLAY_CHROMIUM_PATH }
        : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Chromium could not start. Run "npx playwright install chromium" or use the RoutePlay Docker image.\n${message}`,
    );
  }
}
