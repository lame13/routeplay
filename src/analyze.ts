import { baselineEntryFor } from "./baseline.js";
import { textSimilarity } from "./similarity.js";
import type {
  BaselineFile,
  Capture,
  CompareSettings,
  Comparison,
  Finding,
  HreflangEntry,
  NavigationMode,
  Phase,
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

interface FieldRules {
  url: string;
  title: string;
  description: string;
  canonical: string;
  robots: string;
  h1: string;
  main: string;
  links: string;
  jsonLd: string;
  lang: string;
  hreflangs: string;
}

const surfaceNames: Record<Phase, string> = {
  server: "server HTML",
  cold: "the cold load",
  transition: "in-app navigation",
};

const parityComparisonLabels: Record<"server-cold" | "cold-transition", string> = {
  "server-cold": "server and cold",
  "cold-transition": "cold and transition",
};

const parityRules: FieldRules = {
  url: "RP101",
  title: "RP102",
  description: "RP103",
  canonical: "RP104",
  robots: "RP105",
  h1: "RP106",
  main: "RP107",
  links: "RP108",
  jsonLd: "RP110",
  lang: "RP501",
  hreflangs: "RP502",
};

const baselineRules: FieldRules = {
  url: "RP401",
  title: "RP402",
  description: "RP403",
  canonical: "RP404",
  robots: "RP405",
  h1: "RP406",
  main: "RP407",
  links: "RP408",
  jsonLd: "RP409",
  lang: "RP410",
  hreflangs: "RP411",
};

function compareField(
  findings: Finding[],
  comparison: Comparison,
  phrase: string,
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
    message: `${label} differs between ${phrase}.`,
    expected,
    actual,
  });
}

function hreflangKeys(entries: HreflangEntry[]): string[] {
  return entries.map((entry) => `${entry.hreflang} ${entry.href}`);
}

function compareSemanticFields(
  findings: Finding[],
  comparison: Comparison,
  phrase: string,
  rules: FieldRules,
  severity: Finding["severity"],
  expected: SemanticSnapshot,
  actual: SemanticSnapshot,
  settings: CompareSettings,
  options: { includeUrl?: boolean } = {},
): void {
  const compare = (ruleId: string, label: string, left: unknown, right: unknown): void =>
    compareField(findings, comparison, phrase, ruleId, label, left, right, severity);

  if (options.includeUrl) compare(rules.url, "Final route URL", expected.url, actual.url);
  compare(rules.title, "Title", expected.titles, actual.titles);
  compare(rules.description, "Meta description", expected.descriptions, actual.descriptions);
  compare(rules.canonical, "Canonical URL", expected.canonicals, actual.canonicals);
  compare(rules.robots, "Robots directives", expected.robots, actual.robots);
  compare(rules.h1, "H1", expected.h1, actual.h1);
  compare(rules.lang, "Document language", expected.lang, actual.lang);
  compare(rules.jsonLd, "JSON-LD blocks", expected.jsonLdFingerprints, actual.jsonLdFingerprints);

  if (stable(hreflangKeys(expected.hreflangs)) !== stable(hreflangKeys(actual.hreflangs))) {
    findings.push({
      ruleId: rules.hreflangs,
      severity,
      comparison,
      message: `Hreflang alternates differ between ${phrase}.`,
      actual: sampleDifference(hreflangKeys(expected.hreflangs), hreflangKeys(actual.hreflangs)),
      hint: "Every surface of a localized route should advertise the same alternates.",
    });
  }

  const similarity = textSimilarity(expected.main.text, actual.main.text);
  if (similarity < settings.minTextSimilarity) {
    findings.push({
      ruleId: rules.main,
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
      ruleId: rules.links,
      severity,
      comparison,
      message: "Crawlable internal-link targets differ.",
      actual: sampleDifference(expected.links, actual.links),
      hint: "Links introduced only by JavaScript are absent from the server surface.",
    });
  }
}

function compareSnapshots(
  findings: Finding[],
  comparison: "server-cold" | "cold-transition",
  expected: SemanticSnapshot,
  actual: SemanticSnapshot,
  settings: CompareSettings,
): void {
  compareSemanticFields(
    findings,
    comparison,
    parityComparisonLabels[comparison],
    parityRules,
    comparison === "cold-transition" ? "error" : "warning",
    expected,
    actual,
    settings,
  );
}

function baselineComparison(phase: Phase): Comparison {
  return `baseline-${phase}` as Comparison;
}

/**
 * Compares a fresh capture against a recorded baseline. Every phase is checked, because a baseline
 * is the only way to notice that all three surfaces agree on newly wrong content.
 */
export function baselineFindings(
  spec: TransitionSpec,
  specHash: string,
  baseline: BaselineFile | undefined,
  captures: { server: Capture; cold: Capture; transition: Capture },
  settings: CompareSettings,
): Finding[] {
  if (!baseline) return [];
  const entry = baselineEntryFor(baseline, spec);
  if (!entry) {
    return [
      {
        ruleId: "RP400",
        severity: "warning",
        message: "No recorded baseline entry covers this transition.",
        hint: 'Run "npx routeplay snapshot" to record the current behavior as the expected one.',
      },
    ];
  }
  if (entry.specHash !== specHash) {
    return [
      {
        ruleId: "RP400",
        severity: "warning",
        message: "The recorded baseline was captured with different transition settings.",
        expected: entry.specHash,
        actual: specHash,
        hint: "Re-record with --update-baseline once the new settings are correct.",
      },
    ];
  }

  const findings: Finding[] = [];
  const pairs: Array<[Phase, SemanticSnapshot]> = [
    ["server", captures.server.semantic],
    ["cold", captures.cold.semantic],
    ["transition", captures.transition.semantic],
  ];
  for (const [phase, snapshot] of pairs) {
    compareSemanticFields(
      findings,
      baselineComparison(phase),
      `the recorded baseline and ${surfaceNames[phase]}`,
      baselineRules,
      "error",
      entry.phases[phase],
      snapshot,
      settings,
      { includeUrl: true },
    );
  }
  return findings;
}

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return value;
  }
}

/**
 * Cross-route hreflang reciprocity, limited to destinations this config covers. A single-transition
 * config therefore never reports anything.
 */
export function hreflangReciprocityFindings(
  routes: Array<{ to: string; hreflangs: HreflangEntry[] }>,
): Finding[][] {
  const declared = new Map<string, HreflangEntry[]>();
  for (const route of routes) declared.set(canonicalUrl(route.to), route.hreflangs);
  return routes.map((route) => {
    const self = canonicalUrl(route.to);
    const findings: Finding[] = [];
    for (const entry of route.hreflangs) {
      const target = canonicalUrl(entry.href);
      if (target === self) continue;
      const other = declared.get(target);
      if (!other) continue;
      if (other.some((candidate) => canonicalUrl(candidate.href) === self)) continue;
      findings.push({
        ruleId: "RP503",
        severity: "warning",
        message: `Hreflang "${entry.hreflang}" points to ${target}, which declares no alternate back to ${self}.`,
        expected: { hreflang: entry.hreflang, href: target },
        actual: { declaredBy: other.map((candidate) => candidate.hreflang) },
        hint: "Reciprocal hreflang links keep locale clusters crawlable.",
      });
    }
    return findings;
  });
}

function humanList(values: string[]): string {
  if (values.length === 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function contractFinding(
  ruleId: string,
  problem: string,
  expected: unknown,
  mismatches: Partial<Record<Phase, unknown>>,
): Finding | undefined {
  const entries = Object.entries(mismatches) as Array<[Phase, unknown]>;
  if (entries.length === 0) return undefined;
  const phases = entries.map(([phase]) => phase);
  return {
    ruleId,
    severity: "error",
    ...(phases.length === 1 ? { phase: phases[0] } : {}),
    message: `${problem} ${humanList(phases.map((phase) => surfaceNames[phase]))}.`,
    expected,
    actual: entries.length === 1 ? entries[0]?.[1] : Object.fromEntries(entries),
  };
}

function exactContractFinding(
  ruleId: string,
  label: string,
  expected: unknown,
  surfaces: Array<[Phase, SemanticSnapshot]>,
  select: (snapshot: SemanticSnapshot) => unknown,
): Finding | undefined {
  const mismatches: Partial<Record<Phase, unknown>> = {};
  for (const [phase, snapshot] of surfaces) {
    const actual = select(snapshot);
    if (stable(expected) !== stable(actual)) mismatches[phase] = actual;
  }
  return contractFinding(
    ruleId,
    `${label} does not match the route contract for`,
    expected,
    mismatches,
  );
}

function inclusionContractFinding(
  ruleId: string,
  label: string,
  required: string[],
  surfaces: Array<[Phase, SemanticSnapshot]>,
  select: (snapshot: SemanticSnapshot) => string[],
  includeFound = false,
): Finding | undefined {
  const mismatches: Partial<Record<Phase, unknown>> = {};
  for (const [phase, snapshot] of surfaces) {
    const actual = select(snapshot);
    const actualSet = new Set(actual);
    const missing = required.filter((value) => !actualSet.has(value));
    if (missing.length > 0) {
      mismatches[phase] = { missing, ...(includeFound ? { found: actual } : {}) };
    }
  }
  return contractFinding(
    ruleId,
    `${label} ${required.length === 1 ? "is" : "are"} missing from`,
    { includes: required },
    mismatches,
  );
}

function routeContractFindings(
  spec: TransitionSpec,
  server: Capture,
  cold: Capture,
  transition: Capture,
): Finding[] {
  const contract = spec.expect;
  if (!contract) return [];
  const surfaces: Array<[Phase, SemanticSnapshot]> = [
    ["server", server.semantic],
    ["cold", cold.semantic],
    ["transition", transition.semantic],
  ];
  const findings: Finding[] = [];
  const add = (finding: Finding | undefined): void => {
    if (finding) findings.push(finding);
  };

  if (contract.title !== undefined) {
    add(
      exactContractFinding("RP301", "Title", [contract.title], surfaces, (value) => value.titles),
    );
  }
  if (contract.description !== undefined) {
    add(
      exactContractFinding(
        "RP302",
        "Meta description",
        [contract.description],
        surfaces,
        (value) => value.descriptions,
      ),
    );
  }
  if (contract.canonical !== undefined) {
    add(
      exactContractFinding(
        "RP303",
        "Canonical URL",
        [contract.canonical],
        surfaces,
        (value) => value.canonicals,
      ),
    );
  }
  if (contract.h1 !== undefined) {
    add(exactContractFinding("RP304", "H1 content", contract.h1, surfaces, (value) => value.h1));
  }
  if (contract.lang !== undefined) {
    add(
      exactContractFinding("RP309", "Document language", [contract.lang], surfaces, (value) => [
        value.lang,
      ]),
    );
  }
  if (contract.robots !== undefined) {
    const agents = Object.keys(contract.robots);
    add(
      exactContractFinding("RP305", "Robots directives", contract.robots, surfaces, (value) =>
        Object.fromEntries(agents.map((agent) => [agent, value.robots[agent] ?? []])),
      ),
    );
  }
  if (contract.jsonLdTypesInclude !== undefined) {
    add(
      inclusionContractFinding(
        "RP306",
        "Required JSON-LD type",
        contract.jsonLdTypesInclude,
        surfaces,
        (value) => value.jsonLdTypes,
        true,
      ),
    );
  }
  if (contract.mainTextIncludes !== undefined) {
    const required = contract.mainTextIncludes;
    const mismatches: Partial<Record<Phase, unknown>> = {};
    for (const [phase, snapshot] of surfaces) {
      const missing = required.filter((fragment) => !snapshot.main.text.includes(fragment));
      if (missing.length > 0) mismatches[phase] = { missing };
    }
    add(
      contractFinding(
        "RP307",
        `Required main-content ${required.length === 1 ? "text is" : "text fragments are"} missing from`,
        { includes: required },
        mismatches,
      ),
    );
  }
  if (contract.linksInclude !== undefined) {
    add(
      inclusionContractFinding(
        "RP308",
        "Required crawlable link",
        contract.linksInclude,
        surfaces,
        (value) => value.links,
      ),
    );
  }
  return findings;
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
    parityComparisonLabels["server-cold"],
    "RP101",
    "Direct response URL",
    withoutHash(spec.expectedFinalUrl),
    server.http ? withoutHash(server.http.responseUrl) : "no response",
    "error",
  );
  compareField(
    findings,
    "server-cold",
    parityComparisonLabels["server-cold"],
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

  findings.push(...routeContractFindings(spec, server, cold, transition));

  compareSnapshots(findings, "server-cold", server.semantic, cold.semantic, settings);
  compareSnapshots(findings, "cold-transition", cold.semantic, transition.semantic, settings);
  compareField(
    findings,
    "cold-transition",
    parityComparisonLabels["cold-transition"],
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
