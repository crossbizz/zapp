import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createFilePlatformAuthVault } from "./vault";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map(async (directory) => await rm(directory, { recursive: true })),
  );
});

describe("platform auth file vault", () => {
  it("atomically persists only the caller-provided encrypted envelope", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zapp-auth-"));
    directories.push(directory);
    const file = join(directory, "nested", "platform-auth.json");
    const vault = createFilePlatformAuthVault(file);
    const encrypted = JSON.stringify({
      encryptedRefreshToken: "ciphertext-only",
    });

    await vault.write(encrypted);

    expect(await vault.read()).toBe(encrypted);
    expect(await readFile(file, "utf8")).toBe(encrypted);
    expect(await readFile(file, "utf8")).not.toContain(
      "refresh-token-plaintext",
    );
    await vault.clear();
    await expect(vault.read()).resolves.toBeUndefined();
  });
});
