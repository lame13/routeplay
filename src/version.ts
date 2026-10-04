import { readFileSync } from "node:fs";

function readPackageVersion(): string {
  const metadata = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as unknown;
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("version" in metadata) ||
    typeof metadata.version !== "string"
  ) {
    throw new Error("RoutePlay package metadata has no valid version.");
  }
  return metadata.version;
}

export const VERSION = readPackageVersion();
