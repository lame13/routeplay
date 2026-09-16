import { randomUUID } from "node:crypto";
import { type Browser, type BrowserContext, chromium, type Page, type Request } from "playwright";
import { analyzeCaptures } from "./analyze.js";
import {
  type ArtifactBundle,
  type ArtifactPhase,
  emptyArtifactBundle,
  type RuntimeEvidence,
} from "./artifacts.js";
import { extractSemantics, ignoredMainSelectors } from "./extract.js";
import type {
  Capture,
  HttpEvidence,
  NavigationMode,
  RoutePlayConfig,
  RuntimeEvent,
  TransitionResult,
  TransitionSpec,
} from "./types.js";

export interface TransitionOutcome {
  result: TransitionResult;
  artifacts: ArtifactBundle;
}

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

interface SignatureInput {
  mainSelector?: string | undefined;
  ignoreSelectors: string[];
  ignoredMainSelectors: string[];
  compareLinks: boolean;
}

/**
 * Reads the same semantic signature as `extractSemantics` directly from the live DOM. Stability
 * polling therefore never serializes and re-parses the whole document on every tick.
 */
async function pageSignature(
  page: Page,
  spec: TransitionSpec,
  compareLinks: boolean,
): Promise<string> {
  const input: SignatureInput = {
    mainSelector: spec.mainSelector,
    ignoreSelectors: spec.ignoreSelectors,
    ignoredMainSelectors: [...ignoredMainSelectors],
    compareLinks,
  };
  return page.evaluate((options: SignatureInput) => {
    const normalize = (value: string): string =>
      value.normalize("NFKC").replace(/\s+/g, " ").trim();
    const uniqueSorted = (values: string[]): string[] =>
      [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
    const sortStrings = (values: string[]): string[] =>
      [...values].sort((left, right) => left.localeCompare(right));
    const hash = (value: string): string => {
      let result = 2_166_136_261;
      for (let index = 0; index < value.length; index += 1) {
        result ^= value.charCodeAt(index);
        result = Math.imul(result, 16_777_619);
      }
      return (result >>> 0).toString(16);
    };
    const stableJson = (value: unknown): string => {
      if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
      if (typeof value !== "object" || value === null) return JSON.stringify(value);
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort((left, right) => left.localeCompare(right))
        .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
        .join(",")}}`;
    };
    const texts = (selector: string, attribute?: string): string[] =>
      Array.from(document.querySelectorAll(selector))
        .map((element) =>
          normalize(
            attribute ? (element.getAttribute(attribute) ?? "") : (element.textContent ?? ""),
          ),
        )
        .filter(Boolean);

    const robots: Record<string, string[]> = {};
    for (const element of Array.from(document.querySelectorAll("meta[name][content]"))) {
      const name = (element.getAttribute("name") ?? "").trim().toLocaleLowerCase();
      if (name !== "robots" && !name.endsWith("bot")) continue;
      const tokens = (element.getAttribute("content") ?? "")
        .split(/[,;]/)
        .map((token) => normalize(token).toLocaleLowerCase())
        .filter(Boolean);
      robots[name] = uniqueSorted([...(robots[name] ?? []), ...tokens]);
    }
    const sortedRobots = Object.fromEntries(
      Object.entries(robots).sort(([left], [right]) => left.localeCompare(right)),
    );

    const jsonLdTypes: string[] = [];
    const jsonLdFingerprints: string[] = [];
    let invalidJsonLd = 0;
    const collectTypes = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) collectTypes(item);
        return;
      }
      if (typeof value !== "object" || value === null) return;
      const record = value as Record<string, unknown>;
      const type = record["@type"];
      if (typeof type === "string") jsonLdTypes.push(type);
      if (Array.isArray(type)) {
        for (const item of type) if (typeof item === "string") jsonLdTypes.push(item);
      }
      for (const nested of Object.values(record)) collectTypes(nested);
    };
    for (const element of Array.from(
      document.querySelectorAll('script[type="application/ld+json"]'),
    )) {
      const content = (element.textContent ?? "").trim();
      if (!content) continue;
      try {
        const parsed: unknown = JSON.parse(content);
        collectTypes(parsed);
        jsonLdFingerprints.push(hash(stableJson(parsed)));
      } catch {
        invalidJsonLd += 1;
      }
    }

    const mainElement = document.querySelector(options.mainSelector ?? "main") ?? document.body;
    // Import into an inert document so sampling cannot run custom-element constructors.
    const clone = document.implementation.createHTMLDocument().importNode(mainElement, true);
    for (const node of Array.from(
      clone.querySelectorAll(
        [...options.ignoredMainSelectors, ...options.ignoreSelectors].join(","),
      ),
    )) {
      node.remove();
    }
    const mainText = normalize(clone.textContent ?? "");

    const links: string[] = [];
    if (options.compareLinks) {
      const origin = location.origin;
      for (const element of Array.from(document.querySelectorAll("a[href]"))) {
        const href = element.getAttribute("href");
        if (!href || /^(?:mailto|tel|javascript|data):/i.test(href)) continue;
        try {
          const url = new URL(href, document.baseURI);
          if (!/^https?:$/.test(url.protocol) || url.origin !== origin) continue;
          url.hash = "";
          links.push(url.href);
        } catch {
          // Invalid hrefs are not crawlable links.
        }
      }
    }

    const canonicals = texts('link[rel~="canonical" i][href]', "href")
      .map((href) => {
        try {
          return new URL(href, document.baseURI).href;
        } catch {
          return "";
        }
      })
      .filter(Boolean);

    return JSON.stringify({
      url: location.href,
      titles: texts("title"),
      descriptions: texts('meta[name="description" i][content]', "content"),
      canonicals: sortStrings(canonicals),
      robots: sortedRobots,
      h1: texts("h1"),
      jsonLdTypes: uniqueSorted(jsonLdTypes),
      jsonLdFingerprints: sortStrings(jsonLdFingerprints),
      invalidJsonLd,
      mainHash: hash(mainText),
      mainLength: mainText.length,
      ...(options.compareLinks ? { links: uniqueSorted(links) } : {}),
    });
  }, input);
}

async function pageScreenshot(page: Page): Promise<Buffer | undefined> {
  return page
    .screenshot({ fullPage: true, animations: "disabled", timeout: 5_000 })
    .catch(() => undefined);
}

async function recordSurface(
  page: Page,
  bundle: ArtifactBundle,
  phase: ArtifactPhase,
  html?: string,
): Promise<void> {
  const content = html ?? (await page.content().catch(() => undefined));
  bundle.surfaces.push({
    phase,
    ...(content ? { html: content } : {}),
    screenshot: await pageScreenshot(page),
  });
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
    let signature: string | undefined;
    try {
      signature = await pageSignature(page, spec, config.compare.compareLinks);
    } catch {
      signature = undefined;
    }
    if (signature === undefined) {
      previous = "";
      stableSince = Date.now();
    } else if (signature !== previous) {
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
  bundle: ArtifactBundle,
  collect: boolean,
): Promise<{ server: Capture; cold: Capture }> {
  const context = await createContext(browser, config);
  const page = await context.newPage();
  const runtime: RuntimeEvent[] = [];
  attachDiagnostics(page, new URL(config.baseUrl).origin, runtime);
  const evidence: RuntimeEvidence = { surface: "cold", runtime };
  if (collect) bundle.runtimes.push(evidence);
  try {
    await installOriginHeaders(context, page, new URL(config.baseUrl).origin, config.headers);
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
    evidence.http = http;
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
    const html = await page.content();
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
      semantic: extractSemantics(html, page.url(), {
        mainSelector: spec.mainSelector,
        ignoreSelectors: spec.ignoreSelectors,
      }),
    };
    if (collect) await recordSurface(page, bundle, "cold", html);
    return { server, cold };
  } catch (error) {
    if (collect) await recordSurface(page, bundle, "cold");
    throw error;
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
  bundle: ArtifactBundle,
  collect: boolean,
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
  attachDiagnostics(page, new URL(config.baseUrl).origin, runtime);
  if (collect) bundle.runtimes.push({ surface: "transition", runtime });
  let clicked = false;
  try {
    await installOriginHeaders(context, page, new URL(config.baseUrl).origin, config.headers);
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
    clicked = true;
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
    const html = await page.content();
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
      semantic: extractSemantics(html, page.url(), {
        mainSelector: spec.mainSelector,
        ignoreSelectors: spec.ignoreSelectors,
      }),
    };
    if (collect) await recordSurface(page, bundle, "transition", html);
    return {
      capture,
      mode,
      anchorHref: anchor.href,
      sourceUrl: sourceResponse.url(),
      sourceLinkInServer,
      ...(documentRequestUrl ? { documentRequestUrl } : {}),
    };
  } catch (error) {
    if (collect) await recordSurface(page, bundle, clicked ? "transition" : "source");
    throw error;
  } finally {
    await context.close();
  }
}

export async function runTransition(
  browser: Browser,
  spec: TransitionSpec,
  config: RoutePlayConfig,
): Promise<TransitionOutcome> {
  const started = Date.now();
  const artifacts = emptyArtifactBundle();
  const collect = config.artifacts !== undefined;
  try {
    const direct = await captureDirect(browser, spec, config, artifacts, collect);
    const warm = await captureTransition(
      browser,
      spec,
      config,
      direct.cold.semantic.url,
      artifacts,
      collect,
    );
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
      result: {
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
        attempts: 1,
        complete: true,
      },
      artifacts,
    };
  } catch (error) {
    const captureError = error instanceof RoutePlayCaptureError ? error : null;
    return {
      result: {
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
        attempts: 1,
        complete: false,
      },
      artifacts,
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
