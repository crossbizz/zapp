import { describe, expect, it, vi } from "vitest";

import {
  PlatformAuthFailure,
  createPlatformAuthSession,
  type PlatformAuthApi,
  type PlatformAuthVault,
} from "./session";
import { restorePlatformAuthForStartup } from "./startup";

const identity = {
  user: {
    id: "user-ada",
    email: "ada@example.test",
    displayName: "Ada Lovelace",
    avatarUrl: null,
  },
  memberships: [
    {
      organization: { id: "org-alpha", name: "Alpha", slug: "alpha" },
      role: "owner" as const,
      status: "active" as const,
      allowedModels: ["anthropic/claude-sonnet-5"],
    },
  ],
};

function memoryVault(): PlatformAuthVault {
  let value: string | undefined;
  return {
    read: () => Promise.resolve(value),
    write: (next) => {
      value = next;
      return Promise.resolve();
    },
    clear: () => {
      value = undefined;
      return Promise.resolve();
    },
  };
}

function cipher() {
  return {
    encrypt: (value: string) => `cipher:${value}`,
    decrypt: (value: string) => value.slice("cipher:".length),
  };
}

function api(overrides: Partial<PlatformAuthApi> = {}): PlatformAuthApi {
  return {
    startDevice: vi.fn(() =>
      Promise.resolve({
        deviceCode: "device-code",
        userCode: "ABCD-EFGH",
        verificationUri: "https://app.zapp.build/device",
        verificationUriComplete:
          "https://app.zapp.build/device?userCode=ABCD-EFGH",
        expiresIn: 600,
        interval: 1,
      }),
    ),
    claimDevice: vi.fn(() =>
      Promise.resolve({
        kind: "authorized" as const,
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresIn: 900,
      }),
    ),
    refresh: vi.fn(() =>
      Promise.resolve({
        accessToken: "restored-access-token",
        refreshToken: "rotated-refresh-token",
        expiresIn: 900,
      }),
    ),
    identity: vi.fn(() => Promise.resolve(identity)),
    logout: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

describe("platform auth startup", () => {
  it("returns cached offline identity without waiting for a stalled refresh", async () => {
    const vault = memoryVault();
    const first = createPlatformAuthSession({
      api: api(),
      vault,
      cipher: cipher(),
      openExternal: vi.fn(() => Promise.resolve()),
      sleep: () => Promise.resolve(),
    });
    await first.signIn();

    const refresh = vi.fn(() => new Promise<never>(() => {}));
    const relaunched = createPlatformAuthSession({
      api: api({ refresh }),
      vault,
      cipher: cipher(),
      openExternal: vi.fn(() => Promise.resolve()),
      sleep: () => Promise.resolve(),
    });

    const startup = await restorePlatformAuthForStartup(relaunched);
    expect(startup.state).toMatchObject({
      status: "offline",
      cloudEnabled: false,
      identity,
    });
    expect(refresh).toHaveBeenCalledWith("refresh-token");
    expect(relaunched.snapshot()).toMatchObject({ status: "offline" });
    expect(startup.background).toBeInstanceOf(Promise);
  });

  it("fails closed when cached credentials cannot be decrypted", async () => {
    const vault = memoryVault();
    await vault.write("not-a-session");
    const relaunched = createPlatformAuthSession({
      api: api({
        refresh: vi.fn(() =>
          Promise.reject(new PlatformAuthFailure("network")),
        ),
      }),
      vault,
      cipher: cipher(),
      openExternal: vi.fn(() => Promise.resolve()),
      sleep: () => Promise.resolve(),
    });

    const startup = await restorePlatformAuthForStartup(relaunched);
    expect(startup.state).toEqual({ status: "signed-out" });
  });
});
