import { app, safeStorage, shell } from "electron";
import { join } from "node:path";

import { createHttpPlatformAuthApi } from "./http";
import {
  createPlatformAuthSession,
  type PlatformAuthCipher,
  type PlatformAuthSession,
} from "./session";
import { createFilePlatformAuthVault } from "./vault";

export function createSafeStorageCipher(): PlatformAuthCipher {
  const available = (): void => {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Keychain-backed safeStorage is unavailable.");
    }
  };
  return {
    encrypt(value) {
      available();
      return safeStorage.encryptString(value).toString("base64");
    },
    decrypt(value) {
      available();
      return safeStorage.decryptString(Buffer.from(value, "base64"));
    },
  };
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException("Authentication was cancelled", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Authentication was cancelled", "AbortError"));
      },
      { once: true },
    );
  });
}

export function createElectronPlatformAuthSession(options: {
  readonly baseUrl: string;
  readonly filePath?: string;
}): PlatformAuthSession {
  return createPlatformAuthSession({
    api: createHttpPlatformAuthApi(options.baseUrl),
    vault: createFilePlatformAuthVault(
      options.filePath ?? join(app.getPath("userData"), "platform-auth.json"),
    ),
    cipher: createSafeStorageCipher(),
    openExternal: async (url) => {
      await shell.openExternal(url);
    },
    sleep,
  });
}
