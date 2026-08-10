import { afterEach, describe, expect, it, vi } from "vitest";

import { createHttpPlatformAuthApi } from "./http";
import { PlatformAuthFailure } from "./session";

const baseUrl = "https://api.zapp.build";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HTTP platform auth adapter", () => {
  it("maps the strict device flow and keeps pending as a non-error state", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        json(200, {
          deviceCode: "device-code",
          userCode: "ABCD-EFGH",
          verificationUri: "https://app.zapp.build/device",
          verificationUriComplete:
            "https://app.zapp.build/device?userCode=ABCD-EFGH",
          expiresIn: 600,
          interval: 5,
        }),
      )
      .mockResolvedValueOnce(
        json(400, {
          error: {
            code: "authorization_pending",
            message: "pending",
            requestId: "req-1",
          },
        }),
      )
      .mockResolvedValueOnce(
        json(200, {
          tokenType: "Bearer",
          accessToken: "access-token",
          refreshToken: "refresh-token",
          expiresIn: 900,
        }),
      );
    vi.stubGlobal("fetch", fetch);
    const api = createHttpPlatformAuthApi(baseUrl);

    await expect(api.startDevice()).resolves.toMatchObject({
      deviceCode: "device-code",
    });
    await expect(api.claimDevice("device-code")).resolves.toEqual({
      kind: "pending",
    });
    await expect(api.claimDevice("device-code")).resolves.toMatchObject({
      kind: "authorized",
      accessToken: "access-token",
      refreshToken: "refresh-token",
    });
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({ deviceCode: "device-code" }),
    );
  });

  it("sends the access token only to the identity read", async () => {
    const fetch = vi.fn().mockResolvedValue(
      json(200, {
        user: {
          id: "user-ada",
          email: "ada@example.test",
          displayName: "Ada Lovelace",
          avatarUrl: null,
        },
        memberships: [],
      }),
    );
    vi.stubGlobal("fetch", fetch);

    await createHttpPlatformAuthApi(baseUrl).identity("memory-only-access");

    const headers = fetch.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer memory-only-access");
  });

  it("classifies a rejected refresh as revoked without exposing response text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json(401, {
          error: {
            code: "invalid_refresh_token",
            message: "secret-bearing provider detail",
            requestId: "req-2",
          },
        }),
      ),
    );

    const error = await createHttpPlatformAuthApi(baseUrl)
      .refresh("refresh-token")
      .catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(PlatformAuthFailure);
    expect((error as PlatformAuthFailure).kind).toBe("revoked");
    expect((error as Error).message).not.toContain("secret-bearing");
  });
});
