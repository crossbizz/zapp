import { describe, expect, it, vi } from "vitest";

import {
  PlatformAuthFailure,
  createPlatformAuthSession,
  type PlatformAuthApi,
  type PlatformAuthVault,
} from "./session";

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

const identityWithBeta = {
  ...identity,
  memberships: [
    ...identity.memberships,
    {
      organization: { id: "org-beta", name: "Beta", slug: "beta" },
      role: "builder" as const,
      status: "active" as const,
      allowedModels: ["anthropic/claude-sonnet-5"],
    },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function memoryVault(): PlatformAuthVault & {
  readonly raw: () => string | undefined;
} {
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
    raw: () => value,
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

function cipher() {
  return {
    encrypt: vi.fn(
      (value: string) => `cipher:${Buffer.from(value).toString("base64")}`,
    ),
    decrypt: vi.fn((value: string) =>
      Buffer.from(value.slice("cipher:".length), "base64").toString("utf8"),
    ),
  };
}

describe("platform auth session", () => {
  it("opens the device flow and persists only an encrypted refresh token", async () => {
    const vault = memoryVault();
    const authApi = api({
      claimDevice: vi
        .fn()
        .mockResolvedValueOnce({ kind: "pending" as const })
        .mockResolvedValueOnce({
          kind: "authorized" as const,
          accessToken: "access-token",
          refreshToken: "refresh-token",
          expiresIn: 900,
        }),
    });
    const openExternal = vi.fn(() => Promise.resolve());
    const auth = createPlatformAuthSession({
      api: authApi,
      vault,
      cipher: cipher(),
      openExternal,
      sleep: () => Promise.resolve(),
    });

    await expect(auth.signIn()).resolves.toMatchObject({
      status: "authenticated",
      cloudEnabled: true,
      selectedOrganizationId: "org-alpha",
    });
    expect(openExternal).toHaveBeenCalledWith(
      "https://app.zapp.build/device?userCode=ABCD-EFGH",
    );
    expect(authApi.claimDevice).toHaveBeenCalledTimes(2);
    expect(auth.authorizationHeader()).toBe("Bearer access-token");
    expect(vault.raw()).toContain("cipher:");
    expect(vault.raw()).not.toContain("refresh-token");
    expect(vault.raw()).not.toContain("access-token");
  });

  it("restores a relaunched session without opening the browser", async () => {
    const vault = memoryVault();
    const first = createPlatformAuthSession({
      api: api(),
      vault,
      cipher: cipher(),
      openExternal: vi.fn(() => Promise.resolve()),
      sleep: () => Promise.resolve(),
    });
    await first.signIn();

    const restoredApi = api();
    const openExternal = vi.fn(() => Promise.resolve());
    const relaunched = createPlatformAuthSession({
      api: restoredApi,
      vault,
      cipher: cipher(),
      openExternal,
      sleep: () => Promise.resolve(),
    });

    await expect(relaunched.restore()).resolves.toMatchObject({
      status: "authenticated",
      selectedOrganizationId: "org-alpha",
    });
    expect(restoredApi.refresh).toHaveBeenCalledWith("refresh-token");
    expect(openExternal).not.toHaveBeenCalled();
    expect(relaunched.authorizationHeader()).toBe(
      "Bearer restored-access-token",
    );
  });

  it("falls back to cached identity offline with cloud features disabled", async () => {
    const vault = memoryVault();
    const first = createPlatformAuthSession({
      api: api(),
      vault,
      cipher: cipher(),
      openExternal: vi.fn(() => Promise.resolve()),
      sleep: () => Promise.resolve(),
    });
    await first.signIn();
    const offline = createPlatformAuthSession({
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

    await expect(offline.restore()).resolves.toMatchObject({
      status: "offline",
      cloudEnabled: false,
      identity,
    });
    expect(offline.authorizationHeader()).toBeUndefined();
  });

  it("persists the rotated refresh token before an offline identity lookup", async () => {
    const vault = memoryVault();
    const first = createPlatformAuthSession({
      api: api(),
      vault,
      cipher: cipher(),
      openExternal: vi.fn(() => Promise.resolve()),
      sleep: () => Promise.resolve(),
    });
    await first.signIn();

    const interrupted = createPlatformAuthSession({
      api: api({
        identity: vi.fn(() =>
          Promise.reject(new PlatformAuthFailure("network")),
        ),
      }),
      vault,
      cipher: cipher(),
      openExternal: vi.fn(() => Promise.resolve()),
      sleep: () => Promise.resolve(),
    });
    await expect(interrupted.restore()).resolves.toMatchObject({
      status: "offline",
      cloudEnabled: false,
    });

    const relaunchedApi = api();
    const relaunched = createPlatformAuthSession({
      api: relaunchedApi,
      vault,
      cipher: cipher(),
      openExternal: vi.fn(() => Promise.resolve()),
      sleep: () => Promise.resolve(),
    });
    await expect(relaunched.restore()).resolves.toMatchObject({
      status: "authenticated",
    });
    expect(relaunchedApi.refresh).toHaveBeenCalledWith("rotated-refresh-token");
  });

  it("purges a revoked refresh token and returns a clean login state", async () => {
    const vault = memoryVault();
    const first = createPlatformAuthSession({
      api: api(),
      vault,
      cipher: cipher(),
      openExternal: vi.fn(() => Promise.resolve()),
      sleep: () => Promise.resolve(),
    });
    await first.signIn();
    const revoked = createPlatformAuthSession({
      api: api({
        refresh: vi.fn(() =>
          Promise.reject(new PlatformAuthFailure("revoked")),
        ),
      }),
      vault,
      cipher: cipher(),
      openExternal: vi.fn(() => Promise.resolve()),
      sleep: () => Promise.resolve(),
    });

    await expect(revoked.restore()).resolves.toEqual({ status: "signed-out" });
    expect(vault.raw()).toBeUndefined();
    expect(revoked.authorizationHeader()).toBeUndefined();
  });

  it("selects only active organizations and sign-out purges every token", async () => {
    const vault = memoryVault();
    const authApi = api();
    const auth = createPlatformAuthSession({
      api: authApi,
      vault,
      cipher: cipher(),
      openExternal: vi.fn(() => Promise.resolve()),
      sleep: () => Promise.resolve(),
    });
    await auth.signIn();

    await expect(auth.selectOrganization("org-missing")).rejects.toThrow(
      "active organization",
    );
    await auth.signOut();
    expect(authApi.logout).toHaveBeenCalledWith("refresh-token");
    expect(vault.raw()).toBeUndefined();
    expect(auth.snapshot()).toEqual({ status: "signed-out" });
  });

  it("retries a failed remote logout after relaunch without restoring the session", async () => {
    const vault = memoryVault();
    const firstApi = api({
      logout: vi.fn(() => Promise.reject(new PlatformAuthFailure("network"))),
    });
    const first = createPlatformAuthSession({
      api: firstApi,
      vault,
      cipher: cipher(),
      openExternal: vi.fn(() => Promise.resolve()),
      sleep: () => Promise.resolve(),
    });
    await first.signIn();

    await expect(first.signOut()).resolves.toBeUndefined();
    expect(first.snapshot()).toEqual({ status: "signed-out" });
    expect(first.authorizationHeader()).toBeUndefined();
    expect(vault.raw()).toBeDefined();

    const relaunchedApi = api();
    const relaunched = createPlatformAuthSession({
      api: relaunchedApi,
      vault,
      cipher: cipher(),
      openExternal: vi.fn(() => Promise.resolve()),
      sleep: () => Promise.resolve(),
    });
    await expect(relaunched.restore()).resolves.toEqual({
      status: "signed-out",
    });
    expect(relaunchedApi.logout).toHaveBeenCalledWith("refresh-token");
    expect(relaunchedApi.refresh).not.toHaveBeenCalled();
    expect(vault.raw()).toBeUndefined();
  });

  it("never overwrites a pending revocation with a new device grant", async () => {
    const vault = memoryVault();
    const first = createPlatformAuthSession({
      api: api({
        logout: vi.fn(() => Promise.reject(new PlatformAuthFailure("network"))),
      }),
      vault,
      cipher: cipher(),
      openExternal: vi.fn(() => Promise.resolve()),
      sleep: () => Promise.resolve(),
    });
    await first.signIn();
    await first.signOut();

    const startDevice = vi.fn(api().startDevice);
    const relaunched = createPlatformAuthSession({
      api: api({
        startDevice,
        logout: vi.fn(() => Promise.reject(new PlatformAuthFailure("network"))),
      }),
      vault,
      cipher: cipher(),
      openExternal: vi.fn(() => Promise.resolve()),
      sleep: () => Promise.resolve(),
    });
    await relaunched.restore();

    await expect(relaunched.signIn()).rejects.toMatchObject({
      kind: "network",
    });
    expect(startDevice).not.toHaveBeenCalled();
    expect(vault.raw()).toContain("revocation-pending");
    expect(vault.raw()).not.toContain("refresh-token");
  });

  it("cannot resurrect a session when background identity refresh finishes after sign-out", async () => {
    const vault = memoryVault();
    const first = createPlatformAuthSession({
      api: api(),
      vault,
      cipher: cipher(),
      openExternal: vi.fn(() => Promise.resolve()),
      sleep: () => Promise.resolve(),
    });
    await first.signIn();

    const identityResult = deferred<typeof identity>();
    const relaunchedApi = api({
      identity: vi.fn(() => identityResult.promise),
      logout: vi.fn(() => Promise.reject(new PlatformAuthFailure("network"))),
    });
    const relaunched = createPlatformAuthSession({
      api: relaunchedApi,
      vault,
      cipher: cipher(),
      openExternal: vi.fn(() => Promise.resolve()),
      sleep: () => Promise.resolve(),
    });
    await relaunched.restoreCached();
    const observed: string[] = [];
    relaunched.subscribe((next) => observed.push(next.status));

    const background = relaunched.refresh();
    await vi.waitFor(() => expect(relaunchedApi.identity).toHaveBeenCalled());
    await relaunched.signOut();
    identityResult.resolve(identity);
    await background;

    expect(relaunched.snapshot()).toEqual({ status: "signed-out" });
    expect(relaunched.authorizationHeader()).toBeUndefined();
    expect(vault.raw()).toContain("revocation-pending");
    expect(observed).toEqual(["signed-out"]);
  });

  it("preserves organization selection made during background identity refresh", async () => {
    const vault = memoryVault();
    const first = createPlatformAuthSession({
      api: api({ identity: vi.fn(() => Promise.resolve(identityWithBeta)) }),
      vault,
      cipher: cipher(),
      openExternal: vi.fn(() => Promise.resolve()),
      sleep: () => Promise.resolve(),
    });
    await first.signIn();

    const identityResult = deferred<typeof identityWithBeta>();
    const relaunchedApi = api({
      identity: vi.fn(() => identityResult.promise),
    });
    const relaunched = createPlatformAuthSession({
      api: relaunchedApi,
      vault,
      cipher: cipher(),
      openExternal: vi.fn(() => Promise.resolve()),
      sleep: () => Promise.resolve(),
    });
    await relaunched.restoreCached();

    const background = relaunched.refresh();
    await vi.waitFor(() => expect(relaunchedApi.identity).toHaveBeenCalled());
    await relaunched.selectOrganization("org-beta");
    identityResult.resolve(identityWithBeta);
    await background;

    expect(relaunched.snapshot()).toMatchObject({
      status: "authenticated",
      selectedOrganizationId: "org-beta",
    });
    expect(vault.raw()).toContain('"selectedOrganizationId":"org-beta"');
  });
});
