import { describe, expect, it, vi } from "vitest";

import { createDesktopPreferenceReader } from "./preferences";

const organizationId = "org_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const userId = "user_01ARZ3NDEKTSV4RRFFQ69G5FAV";

describe("createDesktopPreferenceReader", () => {
  it("loads the public preference API and exposes per-type desktop opt-outs", async () => {
    const request = vi.fn(async (path: string) =>
      path === "/v1/notification-preferences"
        ? {
            preferences: [
              {
                organizationId,
                userId,
                type: "approval_requested",
                email: true,
                inApp: true,
                desktopPush: false,
              },
              {
                organizationId,
                userId,
                type: "run_completed",
                email: true,
                inApp: true,
                desktopPush: true,
              },
            ],
          }
        : {
            preference: {
              organizationId,
              userId,
              type: "approval_requested",
              email: true,
              inApp: true,
              desktopPush: true,
            },
          },
    );
    const reader = createDesktopPreferenceReader({ organizationId, request });

    await reader.refresh();

    expect(request).toHaveBeenCalledWith("/v1/notification-preferences", {
      method: "GET",
      headers: { "x-organization-id": organizationId },
    });
    expect(reader.enabled("approval_requested")).toBe(false);
    expect(reader.enabled("run_completed")).toBe(true);
    expect(reader.enabled("deploy_failed")).toBe(false);

    await reader.set("approval_requested", true);
    expect(request).toHaveBeenLastCalledWith(
      "/v1/notification-preferences/{type}",
      {
        method: "PUT",
        path: { type: "approval_requested" },
        headers: { "x-organization-id": organizationId },
        body: { email: true, inApp: true, desktopPush: true },
      },
    );
    expect(reader.enabled("approval_requested")).toBe(true);
  });

  it("fails closed when the response crosses organizations", async () => {
    const reader = createDesktopPreferenceReader({
      organizationId,
      request: async () => ({
        preferences: [
          {
            organizationId: "org_01ARZ3NDEKTSV4RRFFQ69G5FAW",
            userId,
            type: "run_completed",
            email: true,
            inApp: true,
            desktopPush: true,
          },
        ],
      }),
    });

    await expect(reader.refresh()).rejects.toThrow();
    expect(reader.enabled("run_completed")).toBe(false);
  });
});
