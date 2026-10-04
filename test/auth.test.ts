import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readStorageState, storageStateSecrets } from "../src/auth.js";

describe("storage-state credentials", () => {
  it("keeps structured local storage and IndexedDB values in the redaction set", () => {
    const values = storageStateSecrets({
      cookies: [],
      origins: [
        {
          origin: "https://example.test",
          localStorage: [
            { name: "session", value: JSON.stringify({ accessToken: "local-secret" }) },
          ],
          indexedDB: [
            { name: "auth", stores: [{ records: [{ value: { token: "indexed-secret" } }] }] },
          ],
        },
      ],
    });
    expect(values).toEqual(expect.arrayContaining(["local-secret", "indexed-secret"]));
  });

  it("rejects malformed storage state without exposing parser snippets", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "routeplay-auth-"));
    const file = path.join(directory, "state.json");
    await writeFile(file, '{"private-token": BROKEN}');
    await expect(readStorageState(file)).rejects.toThrow(`Invalid JSON in storage state: ${file}.`);
    await writeFile(file, '{"cookies": "private-token", "origins": []}');
    await expect(readStorageState(file)).rejects.toThrow(
      `Invalid Playwright storage state: ${file}.`,
    );
  });
});
