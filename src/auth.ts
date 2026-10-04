import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const storageStateSchema = z.object({
  cookies: z.array(
    z
      .object({
        name: z.string(),
        value: z.string(),
        domain: z.string(),
        path: z.string(),
        expires: z.number(),
        httpOnly: z.boolean(),
        secure: z.boolean(),
        sameSite: z.enum(["Strict", "Lax", "None"]),
      })
      .passthrough(),
  ),
  origins: z.array(
    z
      .object({
        origin: z.string(),
        localStorage: z.array(z.object({ name: z.string(), value: z.string() })),
        indexedDB: z.array(z.unknown()).optional(),
      })
      .passthrough(),
  ),
});

export type StorageState = z.infer<typeof storageStateSchema>;

/** Read once so every capture and its redaction use the same credential state. */
export async function readStorageState(file: string): Promise<StorageState> {
  const absolute = path.resolve(file);
  let contents: string;
  try {
    contents = await readFile(absolute, "utf8");
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    throw new Error(
      `${missing ? "Storage state file not found" : "Could not read storage state"}: ${absolute}.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    // JSON parser errors can contain a fragment of the credential file.
    throw new Error(`Invalid JSON in storage state: ${absolute}.`);
  }
  const result = storageStateSchema.safeParse(parsed);
  if (!result.success) throw new Error(`Invalid Playwright storage state: ${absolute}.`);
  return result.data;
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return [
        value,
        ...(typeof parsed === "object" && parsed !== null ? stringValues(parsed) : []),
      ];
    } catch {
      return [value];
    }
  }
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (typeof value === "object" && value !== null)
    return Object.values(value).flatMap(stringValues);
  return [];
}

export function storageStateSecrets(state: StorageState | undefined): string[] {
  if (!state) return [];
  return [
    ...state.cookies.map((cookie) => cookie.value),
    ...state.origins.flatMap((origin) => [
      ...origin.localStorage.flatMap((entry) => stringValues(entry.value)),
      ...stringValues(origin.indexedDB),
    ]),
  ];
}
