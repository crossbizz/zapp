import { describe, expect, it, vi } from "vitest";

import { ZAPP_PROTOCOL_SCHEME } from "./branding";
import { handleZappDeepLink, parseZappDeepLink } from "./deep_link";

describe("parseZappDeepLink", () => {
  it("parses the auth callback", () => {
    const link = parseZappDeepLink(
      new URL(`${ZAPP_PROTOCOL_SCHEME}://auth/callback?code=abc&state=xyz`),
    );

    expect(link).toEqual({
      route: "auth-callback",
      params: expect.any(URLSearchParams),
    });
    expect(link?.route === "auth-callback" && link.params.get("code")).toBe(
      "abc",
    );
  });

  it("parses a project link and decodes the id", () => {
    expect(
      parseZappDeepLink(new URL(`${ZAPP_PROTOCOL_SCHEME}://project/proj_123`)),
    ).toEqual({ route: "project", projectId: "proj_123" });

    expect(
      parseZappDeepLink(new URL(`${ZAPP_PROTOCOL_SCHEME}://project/a%2Fb`)),
    ).toEqual({ route: "project", projectId: "a/b" });
  });

  it("rejects another scheme", () => {
    expect(parseZappDeepLink(new URL("dyad://auth/callback"))).toBeNull();
    expect(parseZappDeepLink(new URL("https://zapp.build/auth/callback"))).toBe(
      null,
    );
  });

  it("rejects unknown or incomplete routes", () => {
    for (const url of [
      `${ZAPP_PROTOCOL_SCHEME}://auth`,
      `${ZAPP_PROTOCOL_SCHEME}://auth/`,
      `${ZAPP_PROTOCOL_SCHEME}://auth/logout`,
      `${ZAPP_PROTOCOL_SCHEME}://auth/callback/extra`,
      `${ZAPP_PROTOCOL_SCHEME}://project`,
      `${ZAPP_PROTOCOL_SCHEME}://project/`,
      `${ZAPP_PROTOCOL_SCHEME}://project/id/extra`,
      `${ZAPP_PROTOCOL_SCHEME}://supabase-oauth-return?token=a`,
    ]) {
      expect(parseZappDeepLink(new URL(url)), url).toBeNull();
    }
  });
});

describe("handleZappDeepLink", () => {
  it("focuses the window for a route it owns and reports it handled", () => {
    const focusWindow = vi.fn();
    const log = vi.fn();

    const handled = handleZappDeepLink(
      new URL(`${ZAPP_PROTOCOL_SCHEME}://project/proj_123`),
      { focusWindow, log },
    );

    expect(handled).toBe(true);
    expect(focusWindow).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      "Handling zapp deep link",
      expect.objectContaining({ route: "project", projectId: "proj_123" }),
    );
  });

  it("never logs auth callback parameter values", () => {
    const log = vi.fn();

    handleZappDeepLink(
      new URL(
        `${ZAPP_PROTOCOL_SCHEME}://auth/callback?code=super-secret&state=xyz`,
      ),
      { focusWindow: vi.fn(), log },
    );

    expect(JSON.stringify(log.mock.calls)).not.toContain("super-secret");
    expect(log).toHaveBeenCalledWith(
      "Handling zapp deep link",
      expect.objectContaining({ route: "auth-callback" }),
    );
  });

  it("leaves routes it does not own to the caller", () => {
    const focusWindow = vi.fn();

    expect(
      handleZappDeepLink(
        new URL(`${ZAPP_PROTOCOL_SCHEME}://supabase-oauth-return?token=a`),
        { focusWindow, log: vi.fn() },
      ),
    ).toBe(false);
    expect(focusWindow).not.toHaveBeenCalled();
  });
});
