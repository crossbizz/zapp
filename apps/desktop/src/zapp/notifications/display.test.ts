import { describe, expect, it, vi } from "vitest";

import { createNativeNotificationDisplay } from "./display";
import type { NativeNotificationOptions } from "./display";

const notification = {
  body: "A run is waiting for your approval.",
  deepLink: "zapp://project/proj_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  eventId: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  preferenceType: "approval_requested" as const,
  title: "Approval requested",
};

describe("createNativeNotificationDisplay", () => {
  it("shows a tagged native notification and opens its validated deep link", async () => {
    const handle: { onclick: (() => void) | null } = { onclick: null };
    const create = vi.fn(
      (_title: string, _options: NativeNotificationOptions) => handle,
    );
    const openDeepLink = vi.fn();
    const display = createNativeNotificationDisplay({
      create,
      openDeepLink,
      permission: () => "granted",
    });

    await expect(display(notification)).resolves.toBe(true);
    expect(create).toHaveBeenCalledWith("Approval requested", {
      body: notification.body,
      tag: notification.eventId,
    });
    handle.onclick?.();
    expect(openDeepLink).toHaveBeenCalledWith(notification.deepLink);
  });

  it("accepts the tenant/project/run deep links emitted by the public notification API", async () => {
    const create = vi.fn(() => ({ onclick: null }));
    const display = createNativeNotificationDisplay({
      create,
      openDeepLink: vi.fn(),
      permission: () => "granted",
    });

    await expect(
      display({
        ...notification,
        deepLink:
          "zapp://organizations/org_01ARZ3NDEKTSV4RRFFQ69G5FAV/projects/proj_01ARZ3NDEKTSV4RRFFQ69G5FAV/runs/run_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      }),
    ).resolves.toBe(true);
    expect(create).toHaveBeenCalledOnce();
  });

  it("does nothing without permission or for an invalid deep link", async () => {
    const create = vi.fn();
    const display = createNativeNotificationDisplay({
      create,
      openDeepLink: vi.fn(),
      permission: () => "denied",
    });

    await expect(display(notification)).resolves.toBe(false);
    await expect(
      createNativeNotificationDisplay({
        create,
        openDeepLink: vi.fn(),
        permission: () => "granted",
      })({ ...notification, deepLink: "https://example.com" }),
    ).resolves.toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});
