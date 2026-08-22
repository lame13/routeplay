import { textSimilarity } from "./similarity.js";
import type {
  Capture,
  CompareSettings,
  Comparison,
  Finding,
  NavigationMode,
  RuntimeEvent,
  SemanticSnapshot,
  TransitionSpec,
} from "./types.js";

function stable(value: unknown): string {
  return JSON.stringify(value);
}

function withoutHash(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.href;
}

function sampleDifference(
  expected: string[],
  actual: string[],
): { missing: string[]; added: string[] } {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return {
    missing: expected.filter((value) => !actualSet.has(value)).slice(0, 10),
    added: actual.filter((value) => !expectedSet.has(value)).slice(0, 10),
  };
}

function compareField(
  findings: Finding[],
  comparison: Comparison,
  ruleId: string,
  label: string,
  expected: unknown,
  actual: unknown,
  severity: Finding["severity"],
): void {
  if (stable(expected) === stable(actual)) return;
  findings.push({
    ruleId,
    severity,
    comparison,
    message: `${label} differs between ${comparison.replace("-", " and ")}.`,
    expected,
    actual,
  });
}

function compareSnapshots(
  findings: Finding[],
  comparison: Comparison,
  expected: SemanticSnapshot,
  actual: SemanticSnapshot,
  settings: CompareSettings,
): void {
  const severity = comparison === "cold-transition" ? "error" : "warning";
  compareField(findings, comparison, "RP102", "Title", expected.titles, actual.titles, severity);
  compareField(
    findings,
    comparison,
    "RP103",
    "Meta description",
    expected.descriptions,
    actual.descriptions,
    severity,
  );
  compareField(
    findings,
    comparison,
    "RP104",
    "Canonical URL",
    expected.canonicals,
    actual.canonicals,
    severity,
  );
  compareField(
    findings,
    comparison,
    "RP105",
    "Robots directives",
    expected.robots,
    actual.robots,
    severity,
  );
  compareField(findings, comparison, "RP106", "H1", expected.h1, actual.h1, severity);
  compareField(
    findings,
    comparison,
    "RP110",
    "JSON-LD blocks",
    expected.jsonLdFingerprints,
    actual.jsonLdFingerprints,
    severity,
  );

  const similarity = textSimilarity(expected.main.text, actual.main.text);
  if (similarity < settings.minTextSimilarity) {
    findings.push({
      ruleId: "RP107",
      severity,
      comparison,
      message: `Main-content similarity is ${similarity.toFixed(3)}, below ${settings.minTextSimilarity.toFixed(3)}.`,
      expected: { hash: expected.main.hash, length: expected.main.length },
      actual: { hash: actual.main.hash, length: actual.main.length, similarity },
      hint: "Use mainSelector/ignoreSelectors for intentionally dynamic regions.",
    });
  }

  if (settings.compareLinks && stable(expected.links) !== stable(actual.links)) {
    findings.push({
      ruleId: "RP108",
      severity,
      comparison,
      message: "Crawlable internal-link targets differ.",
      actual: sampleDifference(expected.links, actual.links),
      hint: "Links introduced only by JavaScript are absent from the server surface.",
    });
  }
}

function runtimeFindings(events: RuntimeEvent[], phase: "cold" | "transition"): Finding[] {
  return events.map((event) => {
    const sameOrigin = event.sameOrigin ?? false;
    if (event.kind === "page-error") {
      return { ruleId: "RP201", severity: "error", phase, message: event.message };
    }
    if (event.kind === "console-error") {
      return { ruleId: "RP202", severity: "warning", phase, message: event.message };
    }
    if (event.kind === "request-failed") {
      return {
        ruleId: "RP203",
        severity: sameOrigin ? "error" : "warning",
        phase,
        message: event.message,
        ...(event.url ? { actual: event.url } : {}),
      };
    }
    return {
      ruleId: "RP204",
      severity: sameOrigin ? "error" : "warning",
      phase,
      message: event.message,
      ...(event.status === undefined ? {} : { actual: event.status }),
    };
  });
}

export function analyzeCaptures(
  spec: TransitionSpec,
  server: Capture,
  cold: Capture,
  transition: Capture,
  navigationMode: NavigationMode,
  sourceLinkInServer: boolean,
  settings: CompareSettings,
): Finding[] {
  const findings: Finding[] = [];
  if (!server.http || server.http.status !== spec.expectedStatus) {
    findings.push({
      ruleId: "RP204",
      severity: "error",
      phase: "server",
      message: `Expected direct response status ${spec.expectedStatus}.`,
      expected: spec.expectedStatus,
      actual: server.http?.status ?? "no response",
    });
  }
  compareField(
    findings,
    "server-cold",
    "RP101",
    "Direct response URL",
    withoutHash(spec.expectedFinalUrl),
    server.http ? withoutHash(server.http.responseUrl) : "no response",
    "error",
  );
  compareField(
    findings,
    "server-cold",
    "RP101",
    "Cold browser URL",
    spec.expectedFinalUrl,
    cold.semantic.url,
    "error",
  );
  if (!sourceLinkInServer) {
    findings.push({
      ruleId: "RP113",
      severity: "error",
      phase: "server",
      message: "The configured destination link exists after JavaScript but not in source HTML.",
      expected: spec.to,
      hint: "Render a real <a href> in the source response so crawlers can discover the route.",
    });
  }
  if (server.semantic.main.length < settings.minSourceTextLength) {
    findings.push({
      ruleId: "RP109",
      severity: "warning",
      phase: "server",
      message: `Server main content is only ${server.semantic.main.length} characters.`,
      expected: `>= ${settings.minSourceTextLength}`,
      actual: server.semantic.main.length,
      hint: "Critical route content may be client-rendered only.",
    });
  }
  if (spec.mainSelector && server.semantic.main.selector !== spec.mainSelector) {
    findings.push({
      ruleId: "RP114",
      severity: "error",
      phase: "server",
      message: `Configured main selector ${spec.mainSelector} is absent from server HTML.`,
      expected: spec.mainSelector,
      actual: server.semantic.main.selector,
    });
  }
  if (cold.semantic.linkLikeWithoutHref > 0) {
    findings.push({
      ruleId: "RP111",
      severity: "warning",
      phase: "cold",
      message: `${cold.semantic.linkLikeWithoutHref} link-like element(s) have no crawlable href.`,
    });
  }
  if (
    server.semantic.invalidJsonLd > 0 ||
    cold.semantic.invalidJsonLd > 0 ||
    transition.semantic.invalidJsonLd > 0
  ) {
    findings.push({
      ruleId: "RP112",
      severity: "warning",
      message: "Invalid JSON-LD was found in one or more route surfaces.",
      actual: {
        server: server.semantic.invalidJsonLd,
        cold: cold.semantic.invalidJsonLd,
        transition: transition.semantic.invalidJsonLd,
      },
    });
  }

  compareSnapshots(findings, "server-cold", server.semantic, cold.semantic, settings);
  compareSnapshots(findings, "cold-transition", cold.semantic, transition.semantic, settings);
  compareField(
    findings,
    "cold-transition",
    "RP101",
    "Final URL",
    cold.semantic.url,
    transition.semantic.url,
    "error",
  );

  if (spec.requireClientNavigation && navigationMode !== "client") {
    findings.push({
      ruleId: "RP004",
      severity: "error",
      message: `Expected client navigation but observed ${navigationMode}.`,
      expected: "client",
      actual: navigationMode,
    });
  } else {
    findings.push({
      ruleId: "RP004",
      severity: "info",
      message: `Observed ${navigationMode} navigation.`,
      actual: navigationMode,
    });
  }
  findings.push(
    ...runtimeFindings(cold.runtime, "cold"),
    ...runtimeFindings(transition.runtime, "transition"),
  );
  return findings;
}
