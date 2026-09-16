export type Severity = "error" | "warning" | "info";
export type Phase = "server" | "cold" | "transition";
export type Comparison = "server-cold" | "cold-transition";
export type NavigationMode = "client" | "document" | "unknown";

export interface RouteExpectations {
  title?: string | undefined;
  description?: string | undefined;
  canonical?: string | undefined;
  h1?: string[] | undefined;
  robots?: Record<string, string[]> | undefined;
  jsonLdTypesInclude?: string[] | undefined;
  mainTextIncludes?: string[] | undefined;
  linksInclude?: string[] | undefined;
}

export interface TransitionSpec {
  name: string;
  from: string;
  to: string;
  expectedFinalUrl: string;
  selector?: string | undefined;
  mainSelector?: string | undefined;
  ignoreSelectors: string[];
  readySelector?: string | undefined;
  expectedStatus: number;
  requireClientNavigation: boolean;
  expect?: RouteExpectations | undefined;
}

export interface BrowserSettings {
  timeoutMs: number;
  settleMs: number;
  locale: string;
  timezoneId: string;
  userAgent?: string | undefined;
  viewport: { width: number; height: number };
}

export interface CompareSettings {
  minTextSimilarity: number;
  minSourceTextLength: number;
  compareLinks: boolean;
}

export interface RoutePlayConfig {
  baseUrl: string;
  transitions: TransitionSpec[];
  browser: BrowserSettings;
  compare: CompareSettings;
  headers: Record<string, string>;
  failOn: "error" | "warning" | "never";
  concurrency: number;
  retries: number;
  artifacts?: string | undefined;
}

export interface SemanticSnapshot {
  url: string;
  titles: string[];
  descriptions: string[];
  canonicals: string[];
  robots: Record<string, string[]>;
  h1: string[];
  jsonLdTypes: string[];
  jsonLdFingerprints: string[];
  invalidJsonLd: number;
  main: {
    selector: string;
    text: string;
    hash: string;
    length: number;
  };
  links: string[];
  linkLikeWithoutHref: number;
}

export interface HttpEvidence {
  requestedUrl: string;
  responseUrl: string;
  status: number;
  contentType: string;
  redirects: string[];
  xRobotsTag: string[];
}

export interface RuntimeEvent {
  kind: "page-error" | "console-error" | "request-failed" | "http-error";
  message: string;
  url?: string;
  status?: number;
  sameOrigin?: boolean;
}

export interface Capture {
  phase: Phase;
  semantic: SemanticSnapshot;
  http?: HttpEvidence;
  runtime: RuntimeEvent[];
}

export interface Finding {
  ruleId: string;
  severity: Severity;
  message: string;
  phase?: Phase;
  comparison?: Comparison;
  expected?: unknown;
  actual?: unknown;
  hint?: string;
}

export interface TransitionResult {
  name: string;
  from: string;
  to: string;
  navigation: {
    mode: NavigationMode;
    anchorHref?: string;
    documentRequestUrl?: string;
    sourceUrl?: string;
    sourceLinkInServer?: boolean;
  };
  captures?: {
    server: Capture;
    cold: Capture;
    transition: Capture;
  };
  findings: Finding[];
  durationMs: number;
  attempts: number;
  artifacts?: Record<string, string> | undefined;
  complete: boolean;
}

export interface RunSummary {
  transitions: number;
  passed: number;
  failed: number;
  incomplete: number;
  errors: number;
  warnings: number;
  info: number;
}

export interface RoutePlayReport {
  schemaVersion: 1;
  tool: { name: "routeplay"; version: string };
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  baseUrl: string;
  environment: {
    browser: "chromium";
    locale: string;
    timezoneId: string;
    viewport: { width: number; height: number };
  };
  policy: { failOn: RoutePlayConfig["failOn"] };
  run: { concurrency: number; retries: number };
  results: TransitionResult[];
  summary: RunSummary;
  passed: boolean;
}

export interface CheckOptions {
  configPath?: string;
  baseUrl?: string;
  from?: string;
  to?: string;
  selector?: string;
  headers?: string[];
  failOn?: RoutePlayConfig["failOn"];
  concurrency?: number;
  retries?: number;
  artifacts?: string;
  format?: "terminal" | "json" | "html" | "sarif";
  output?: string;
}
