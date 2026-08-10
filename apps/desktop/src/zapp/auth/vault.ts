import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { PlatformAuthVault } from "./session";

export function createFilePlatformAuthVault(
  filePath: string,
): PlatformAuthVault {
  return {
    async read() {
      try {
        return await readFile(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw error;
      }
    },
    async write(value) {
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
      const temporary = `${filePath}.${String(process.pid)}.tmp`;
      await writeFile(temporary, value, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, filePath);
    },
    async clear() {
      try {
        await unlink(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}
