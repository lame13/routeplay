import type { Finding, RoutePlayReport } from "../types.js";

const descriptions: Record<string, string> = {
  RP001: "A route surface could not be captured reliably.",
  RP002: "A safe, crawlable anchor for the configured transition was unavailable.",
  RP003: "Clicking the configured anchor did not reach the expected route.",
  RP004: "Observed navigation mode differs from the configured requirement.",
  RP101: "Final route URL differs between cold and in-app navigation.",
  RP102: "Document title differs between route surfaces.",
  RP103: "Meta description differs between route surfaces.",
  RP104: "Canonical URL differs between route surfaces.",
  RP105: "Robots directives differ between route surfaces.",
  RP106: "H1 content differs between route surfaces.",
  RP107: "Main content differs beyond the configured similarity threshold.",
  RP108: "Crawlable internal links differ between route surfaces.",
  RP109: "The server response contains unexpectedly thin main content.",
  RP110: "JSON-LD blocks differ between route surfaces.",
  RP111: "Rendered link-like elements lack crawlable href attributes.",
  RP112: "One or more JSON-LD blocks are invalid JSON.",
  RP113: "A configured destination link is available only after JavaScript.",
  RP114: "The configured main-content selector is absent from server HTML.",
  RP201: "The browser raised an uncaught page error.",
  RP202: "The page wrote an error to the browser console.",
  RP203: "A browser request failed at the network layer.",
  RP204: "A route or required browser request returned an HTTP error.",
  RP301: "Document title does not match the configured route contract.",
  RP302: "Meta description does not match the configured route contract.",
  RP303: "Canonical URL does not match the configured route contract.",
  RP304: "H1 content does not match the configured route contract.",
  RP305: "Robots directives do not match the configured route contract.",
  RP306: "A required JSON-LD type is missing.",
  RP307: "Required text is missing from the route's main content.",
  RP308: "A required crawlable internal link is missing.",
};

function resultFor(finding: Finding, uri: string): object {
  return {
    ruleId: finding.ruleId,
    level:
      finding.severity === "error" ? "error" : finding.severity === "warning" ? "warning" : "note",
    message: { text: finding.hint ? `${finding.message} ${finding.hint}` : finding.message },
    locations: [{ physicalLocation: { artifactLocation: { uri } } }],
    properties: {
      ...(finding.phase ? { phase: finding.phase } : {}),
      ...(finding.comparison ? { comparison: finding.comparison } : {}),
      ...(finding.expected === undefined ? {} : { expected: finding.expected }),
      ...(finding.actual === undefined ? {} : { actual: finding.actual }),
    },
  };
}

export function sarifReport(report: RoutePlayReport): string {
  const ids = [
    ...new Set(
      report.results.flatMap((result) =>
        result.findings
          .filter((finding) => finding.severity !== "info")
          .map((finding) => finding.ruleId),
      ),
    ),
  ];
  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "RoutePlay",
            version: report.tool.version,
            informationUri: "https://github.com/lame13/routeplay",
            rules: ids.map((id) => ({
              id,
              shortDescription: { text: descriptions[id] ?? "RoutePlay finding" },
            })),
          },
        },
        results: report.results.flatMap((result) =>
          result.findings
            .filter((finding) => finding.severity !== "info")
            .map((finding) => resultFor(finding, result.to)),
        ),
      },
    ],
  };
  return JSON.stringify(sarif, null, 2);
}
