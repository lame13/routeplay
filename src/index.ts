export {
  BASELINE_SCHEMA_VERSION,
  baselineEntryFor,
  baselineFromReport,
  DEFAULT_BASELINE_PATH,
  loadBaseline,
  mergeBaseline,
  readBaselineIfPresent,
  transitionSpecHash,
  writeBaseline,
} from "./baseline.js";
export { loadConfig, normalizeUrl } from "./config.js";
export { extractSemantics } from "./extract.js";
export { activeFindings, severityFails } from "./policy.js";
export { runRoutePlay, VERSION } from "./run.js";
export { changedFiles, matchGlob, selectTransitions } from "./scope.js";
export { applySuppressions, todayIso } from "./suppress.js";
export type {
  BaselineEntry,
  BaselineFile,
  BrowserSettings,
  Capture,
  CheckOptions,
  CompareSettings,
  CookieSeed,
  Finding,
  HreflangEntry,
  HttpEvidence,
  IgnoreRule,
  NavigationMode,
  RouteExpectations,
  RoutePlayConfig,
  RoutePlayReport,
  RunScope,
  RunSummary,
  RuntimeEvent,
  SemanticSnapshot,
  Severity,
  SkippedTransition,
  TransitionResult,
  TransitionSpec,
} from "./types.js";
