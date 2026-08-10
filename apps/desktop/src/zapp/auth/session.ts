import { z } from "zod";

const MembershipSchema = z
  .object({
    organization: z
      .object({
        id: z.string().min(1),
        name: z.string().min(1),
        slug: z.string().min(1),
      })
      .strict(),
    role: z.enum(["owner", "builder", "viewer"]),
    status: z.enum(["invited", "active", "removed"]),
    allowedModels: z.array(z.string().min(1)),
  })
  .strict();

export const PlatformIdentitySchema = z
  .object({
    user: z
      .object({
        id: z.string().min(1),
        email: z.string().email(),
        displayName: z.string().min(1),
        avatarUrl: z.string().url().nullable(),
      })
      .strict(),
    memberships: z.array(MembershipSchema),
  })
  .strict();

export type PlatformIdentity = z.infer<typeof PlatformIdentitySchema>;

const ActiveSessionSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("active"),
    encryptedRefreshToken: z.string().min(1),
    identity: PlatformIdentitySchema,
    selectedOrganizationId: z.string().min(1),
  })
  .strict();

const PendingRevocationSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("revocation-pending"),
    encryptedRefreshToken: z.string().min(1),
  })
  .strict();

const PersistedSessionSchema = z.discriminatedUnion("kind", [
  ActiveSessionSchema,
  PendingRevocationSchema,
]);

export interface PlatformAuthVault {
  read(): Promise<string | undefined>;
  write(value: string): Promise<void>;
  clear(): Promise<void>;
}

export interface PlatformAuthCipher {
  encrypt(value: string): string;
  decrypt(value: string): string;
}

export interface DeviceGrant {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresIn: number;
  readonly interval: number;
}

export interface PlatformTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
}

export type DeviceClaim =
  | { readonly kind: "pending" }
  | ({ readonly kind: "authorized" } & PlatformTokens);

export interface PlatformAuthApi {
  startDevice(): Promise<DeviceGrant>;
  claimDevice(deviceCode: string): Promise<DeviceClaim>;
  refresh(refreshToken: string): Promise<PlatformTokens>;
  identity(accessToken: string): Promise<PlatformIdentity>;
  logout(refreshToken: string): Promise<void>;
}

export type PlatformAuthFailureKind =
  | "network"
  | "revoked"
  | "denied"
  | "expired"
  | "protocol";

export class PlatformAuthFailure extends Error {
  readonly kind: PlatformAuthFailureKind;

  constructor(kind: PlatformAuthFailureKind) {
    super(`Platform authentication failed (${kind}).`);
    this.name = "PlatformAuthFailure";
    this.kind = kind;
  }
}

export const PlatformAuthStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("signed-out") }).strict(),
  z
    .object({
      status: z.literal("authenticated"),
      cloudEnabled: z.literal(true),
      identity: PlatformIdentitySchema,
      selectedOrganizationId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal("offline"),
      cloudEnabled: z.literal(false),
      identity: PlatformIdentitySchema,
      selectedOrganizationId: z.string().min(1),
    })
    .strict(),
]);

export type PlatformAuthState = z.infer<typeof PlatformAuthStateSchema>;

function selectedOrganization(
  identity: PlatformIdentity,
  requested?: string,
): string {
  const active = identity.memberships.filter(
    (membership) => membership.status === "active",
  );
  const selected =
    active.find((membership) => membership.organization.id === requested) ??
    active[0];
  if (selected === undefined) {
    throw new PlatformAuthFailure("protocol");
  }
  return selected.organization.id;
}

function parsedGrant(input: DeviceGrant): DeviceGrant {
  return z
    .object({
      deviceCode: z.string().min(1),
      userCode: z.string().min(1),
      verificationUri: z.string().url(),
      verificationUriComplete: z.string().url(),
      expiresIn: z.number().int().positive(),
      interval: z.number().int().positive(),
    })
    .strict()
    .parse(input);
}

function parsedTokens(input: PlatformTokens): PlatformTokens {
  return z
    .object({
      accessToken: z.string().min(1),
      refreshToken: z.string().min(1),
      expiresIn: z.number().int().positive(),
    })
    .strict()
    .parse(input);
}

export interface PlatformAuthSession {
  signIn(signal?: AbortSignal): Promise<PlatformAuthState>;
  restoreCached(): Promise<PlatformAuthState>;
  refresh(): Promise<PlatformAuthState>;
  restore(): Promise<PlatformAuthState>;
  signOut(): Promise<void>;
  selectOrganization(organizationId: string): Promise<PlatformAuthState>;
  snapshot(): PlatformAuthState;
  authorizationHeader(): string | undefined;
  subscribe(listener: (state: PlatformAuthState) => void): () => void;
}

export function createPlatformAuthSession(options: {
  readonly api: PlatformAuthApi;
  readonly vault: PlatformAuthVault;
  readonly cipher: PlatformAuthCipher;
  readonly openExternal: (url: string) => Promise<void>;
  readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}): PlatformAuthSession {
  let state: PlatformAuthState = { status: "signed-out" };
  let accessToken: string | undefined;
  let refreshToken: string | undefined;
  let pendingRevocationToken: string | undefined;
  let authGeneration = 0;
  let transitionTail: Promise<void> = Promise.resolve();
  const listeners = new Set<(state: PlatformAuthState) => void>();

  async function runLocalTransition<T>(
    transition: () => T | Promise<T>,
  ): Promise<T> {
    const result = transitionTail.then(transition);
    transitionTail = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }

  function updateState(next: PlatformAuthState): PlatformAuthState {
    state = PlatformAuthStateSchema.parse(next);
    for (const listener of listeners) listener(state);
    return state;
  }

  async function persist(
    token: string,
    identity: PlatformIdentity,
    selectedOrganizationId: string,
  ): Promise<void> {
    await options.vault.write(
      JSON.stringify(
        PersistedSessionSchema.parse({
          version: 1,
          kind: "active",
          encryptedRefreshToken: options.cipher.encrypt(token),
          identity,
          selectedOrganizationId,
        }),
      ),
    );
  }

  async function persistPendingRevocation(token: string): Promise<void> {
    await options.vault.write(
      JSON.stringify(
        PendingRevocationSchema.parse({
          version: 1,
          kind: "revocation-pending",
          encryptedRefreshToken: options.cipher.encrypt(token),
        }),
      ),
    );
  }

  async function loadPendingRevocation(): Promise<void> {
    if (pendingRevocationToken !== undefined) return;
    const serialized = await options.vault.read();
    if (serialized === undefined) return;
    try {
      const persisted = PersistedSessionSchema.parse(
        JSON.parse(serialized) as unknown,
      );
      if (persisted.kind === "revocation-pending") {
        pendingRevocationToken = options.cipher.decrypt(
          persisted.encryptedRefreshToken,
        );
      }
    } catch {
      await options.vault.clear();
    }
  }

  async function drainPendingRevocation(
    throwOnFailure: boolean,
  ): Promise<boolean> {
    await loadPendingRevocation();
    const token = pendingRevocationToken;
    if (token === undefined) return true;
    try {
      await options.api.logout(token);
    } catch (error) {
      if (error instanceof PlatformAuthFailure && error.kind === "revoked") {
        await runLocalTransition(async () => {
          if (pendingRevocationToken !== token) return;
          pendingRevocationToken = undefined;
          await options.vault.clear();
        });
        return true;
      }
      if (throwOnFailure) throw error;
      return false;
    }
    await runLocalTransition(async () => {
      if (pendingRevocationToken !== token) return;
      pendingRevocationToken = undefined;
      await options.vault.clear();
    });
    return true;
  }

  async function authenticated(
    tokensInput: PlatformTokens,
    requestedOrganization?: string,
    expectedGeneration = authGeneration,
  ) {
    const tokens = parsedTokens(tokensInput);
    const identity = PlatformIdentitySchema.parse(
      await options.api.identity(tokens.accessToken),
    );
    return await runLocalTransition(async () => {
      if (authGeneration !== expectedGeneration) return state;
      const selectedOrganizationId = selectedOrganization(
        identity,
        requestedOrganization,
      );
      await persist(tokens.refreshToken, identity, selectedOrganizationId);
      accessToken = tokens.accessToken;
      refreshToken = tokens.refreshToken;
      return updateState({
        status: "authenticated",
        cloudEnabled: true,
        identity,
        selectedOrganizationId,
      });
    });
  }

  const session: PlatformAuthSession = {
    async signIn(signal) {
      await drainPendingRevocation(true);
      const expectedGeneration = await runLocalTransition(() => {
        authGeneration += 1;
        return authGeneration;
      });
      const grant = parsedGrant(await options.api.startDevice());
      await options.openExternal(grant.verificationUriComplete);
      const maximumPolls = Math.max(
        1,
        Math.ceil(grant.expiresIn / grant.interval),
      );
      for (let poll = 0; poll < maximumPolls; poll += 1) {
        if (signal?.aborted === true)
          throw new DOMException("Authentication was cancelled", "AbortError");
        const claim = await options.api.claimDevice(grant.deviceCode);
        if (claim.kind === "authorized") {
          return await authenticated(
            {
              accessToken: claim.accessToken,
              refreshToken: claim.refreshToken,
              expiresIn: claim.expiresIn,
            },
            undefined,
            expectedGeneration,
          );
        }
        if (poll + 1 < maximumPolls) {
          await options.sleep(grant.interval * 1_000, signal);
        }
      }
      throw new PlatformAuthFailure("expired");
    },

    async restoreCached() {
      const serialized = await options.vault.read();
      if (serialized === undefined)
        return updateState({ status: "signed-out" });
      let persisted: z.infer<typeof PersistedSessionSchema>;
      let decrypted: string;
      try {
        persisted = PersistedSessionSchema.parse(
          JSON.parse(serialized) as unknown,
        );
        decrypted = options.cipher.decrypt(persisted.encryptedRefreshToken);
      } catch {
        await options.vault.clear();
        accessToken = undefined;
        refreshToken = undefined;
        pendingRevocationToken = undefined;
        return updateState({ status: "signed-out" });
      }
      if (persisted.kind === "revocation-pending") {
        accessToken = undefined;
        refreshToken = undefined;
        pendingRevocationToken = decrypted;
        return updateState({ status: "signed-out" });
      }

      accessToken = undefined;
      refreshToken = decrypted;
      pendingRevocationToken = undefined;
      return updateState({
        status: "offline",
        cloudEnabled: false,
        identity: persisted.identity,
        selectedOrganizationId: selectedOrganization(
          persisted.identity,
          persisted.selectedOrganizationId,
        ),
      });
    },

    async refresh() {
      if (pendingRevocationToken !== undefined) {
        await drainPendingRevocation(false);
        return state;
      }
      if (state.status !== "offline" || refreshToken === undefined) {
        return state;
      }

      const expectedGeneration = authGeneration;
      let currentRefreshToken = refreshToken;
      try {
        const tokens = parsedTokens(
          await options.api.refresh(currentRefreshToken),
        );
        currentRefreshToken = tokens.refreshToken;
        const accepted = await runLocalTransition(async () => {
          if (
            authGeneration !== expectedGeneration ||
            state.status === "signed-out"
          ) {
            return false;
          }
          refreshToken = currentRefreshToken;
          await persist(
            currentRefreshToken,
            state.identity,
            state.selectedOrganizationId,
          );
          return true;
        });
        if (!accepted) return state;

        const identity = PlatformIdentitySchema.parse(
          await options.api.identity(tokens.accessToken),
        );
        return await runLocalTransition(async () => {
          if (
            authGeneration !== expectedGeneration ||
            state.status === "signed-out"
          ) {
            return state;
          }
          const selectedOrganizationId = selectedOrganization(
            identity,
            state.selectedOrganizationId,
          );
          await persist(currentRefreshToken, identity, selectedOrganizationId);
          accessToken = tokens.accessToken;
          refreshToken = currentRefreshToken;
          return updateState({
            status: "authenticated",
            cloudEnabled: true,
            identity,
            selectedOrganizationId,
          });
        });
      } catch (error) {
        if (error instanceof PlatformAuthFailure && error.kind === "network") {
          return await runLocalTransition(() => {
            if (
              authGeneration !== expectedGeneration ||
              state.status === "signed-out"
            ) {
              return state;
            }
            accessToken = undefined;
            refreshToken = currentRefreshToken;
            return updateState({
              status: "offline",
              cloudEnabled: false,
              identity: state.identity,
              selectedOrganizationId: state.selectedOrganizationId,
            });
          });
        }
        return await runLocalTransition(async () => {
          if (authGeneration !== expectedGeneration) return state;
          accessToken = undefined;
          refreshToken = undefined;
          pendingRevocationToken = undefined;
          await options.vault.clear();
          return updateState({ status: "signed-out" });
        });
      }
    },

    async restore() {
      await session.restoreCached();
      return await session.refresh();
    },

    async signOut() {
      const token = await runLocalTransition(async () => {
        authGeneration += 1;
        const currentToken = refreshToken;
        accessToken = undefined;
        refreshToken = undefined;
        updateState({ status: "signed-out" });
        if (currentToken !== undefined) {
          await persistPendingRevocation(currentToken);
          pendingRevocationToken = currentToken;
        } else if (pendingRevocationToken === undefined) {
          await options.vault.clear();
        }
        return currentToken;
      });
      if (token !== undefined) await drainPendingRevocation(false);
    },

    async selectOrganization(organizationId) {
      return await runLocalTransition(async () => {
        if (state.status === "signed-out")
          throw new Error("Sign in before selecting an organization.");
        const match = state.identity.memberships.find(
          (membership) =>
            membership.status === "active" &&
            membership.organization.id === organizationId,
        );
        if (match === undefined)
          throw new Error("Select an active organization.");
        if (refreshToken === undefined)
          throw new PlatformAuthFailure("protocol");
        await persist(refreshToken, state.identity, match.organization.id);
        return updateState({
          ...state,
          selectedOrganizationId: match.organization.id,
        });
      });
    },

    snapshot() {
      return state;
    },

    authorizationHeader() {
      return accessToken === undefined ? undefined : `Bearer ${accessToken}`;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return session;
}
