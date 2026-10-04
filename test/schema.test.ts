import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

interface JsonSchemaProperty {
  type?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  default?: unknown;
}

describe("routeplay.schema.json", () => {
  it("documents the run-level keys with the same bounds as the runtime schema", async () => {
    const schema = JSON.parse(
      await readFile(new URL("../routeplay.schema.json", import.meta.url), "utf8"),
    ) as { additionalProperties: boolean; properties: Record<string, JsonSchemaProperty> };

    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining([
        "artifacts",
        "browser",
        "compare",
        "concurrency",
        "failOn",
        "headers",
        "retries",
        "transitions",
      ]),
    );
    expect(schema.properties.concurrency).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 8,
      default: 1,
    });
    expect(schema.properties.retries).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: 3,
      default: 0,
    });
    expect(schema.properties.artifacts).toMatchObject({ type: "string", minLength: 1 });
  });

  it("documents baselines, sessions, repeats, and suppressions", async () => {
    const schema = JSON.parse(
      await readFile(new URL("../routeplay.schema.json", import.meta.url), "utf8"),
    ) as {
      properties: Record<string, { properties?: Record<string, JsonSchemaProperty> }>;
    };

    const browser = schema.properties.browser?.properties ?? {};
    const transition = schema.properties.transitions as unknown as {
      items: { properties: Record<string, JsonSchemaProperty> };
    };
    expect(Object.keys(browser)).toEqual(expect.arrayContaining(["cookies", "storageState"]));
    expect(Object.keys(transition.items.properties)).toContain("paths");
    expect(schema.properties.repeat).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 5,
      default: 1,
    });
    expect(schema.properties.ignore).toMatchObject({ type: "array" });
  });
});
