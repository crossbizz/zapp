import {
  createZappClient,
  ZappApiError,
  ZappProtocolError,
} from "@zapp/api-client";

import {
  PlatformAuthFailure,
  PlatformIdentitySchema,
  type DeviceClaim,
  type DeviceGrant,
  type PlatformAuthApi,
  type PlatformTokens,
} from "./session";

function client(baseUrl: string, accessToken = "") {
  return createZappClient({ baseUrl, getToken: () => accessToken });
}

function tokens(input: {
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly expiresIn: number;
}): PlatformTokens {
  if (input.accessToken === undefined || input.refreshToken === undefined) {
    throw new PlatformAuthFailure("protocol");
  }
  return {
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    expiresIn: input.expiresIn,
  };
}

function failure(
  error: unknown,
  fallback: "network" | "protocol",
): PlatformAuthFailure {
  if (error instanceof PlatformAuthFailure) return error;
  if (error instanceof ZappApiError) {
    if (error.code === "authorization_pending")
      return new PlatformAuthFailure("protocol");
    if (error.code === "access_denied")
      return new PlatformAuthFailure("denied");
    if (
      error.code === "expired_device_code" ||
      error.code === "invalid_device_code"
    ) {
      return new PlatformAuthFailure("expired");
    }
    if (error.status === 401) return new PlatformAuthFailure("revoked");
    return new PlatformAuthFailure("protocol");
  }
  if (error instanceof ZappProtocolError)
    return new PlatformAuthFailure("protocol");
  return new PlatformAuthFailure(fallback);
}

export function createHttpPlatformAuthApi(baseUrl: string): PlatformAuthApi {
  return {
    async startDevice(): Promise<DeviceGrant> {
      try {
        return await client(baseUrl).request("/v1/auth/device", {
          method: "GET",
        });
      } catch (error) {
        throw failure(error, "network");
      }
    },

    async claimDevice(deviceCode: string): Promise<DeviceClaim> {
      try {
        const response = await client(baseUrl).request(
          "/v1/auth/device/token",
          {
            method: "POST",
            body: { deviceCode },
          },
        );
        return { kind: "authorized", ...tokens(response) };
      } catch (error) {
        if (
          error instanceof ZappApiError &&
          error.code === "authorization_pending"
        ) {
          return { kind: "pending" };
        }
        throw failure(error, "network");
      }
    },

    async refresh(refreshToken: string): Promise<PlatformTokens> {
      try {
        return tokens(
          await client(baseUrl).request("/v1/auth/refresh", {
            method: "POST",
            body: { refreshToken },
          }),
        );
      } catch (error) {
        throw failure(error, "network");
      }
    },

    async identity(accessToken: string) {
      try {
        return PlatformIdentitySchema.parse(
          await client(baseUrl, accessToken).request("/v1/me", {
            method: "GET",
          }),
        );
      } catch (error) {
        throw failure(error, "network");
      }
    },

    async logout(refreshToken: string): Promise<void> {
      try {
        await client(baseUrl).request("/v1/auth/logout", {
          method: "POST",
          body: { refreshToken },
        });
      } catch (error) {
        throw failure(error, "network");
      }
    },
  };
}
