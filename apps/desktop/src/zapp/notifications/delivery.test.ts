import { describe, expect, it, vi } from "vitest";

import { createDesktopNotificationDelivery } from "./delivery";

describe("createDesktopNotificationDelivery", () => {
  it("polls the public cursor API, validates tenant-safe links, and resumes from the cursor", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        nextCursor: 4,
        notifications: [
          {
            channel: "desktop_push",
            cursor: 4,
            desktopUrl:
              "zapp://organizations/org_01ARZ3NDEKTSV4RRFFQ69G5FAV/projects/proj_01ARZ3NDEKTSV4RRFFQ69G5FAV/runs/run_01ARZ3NDEKTSV4RRFFQ69G5FAV",
            occurredAt: "2026-08-12T12:00:00.000Z",
            organizationId: "org_01ARZ3NDEKTSV4RRFFQ69G5FAV",
            subject: "Approval requested",
            text: "A run is waiting for approval.",
            triggerId: "approval-1",
            type: "approval_requested",
            userId: "user_01ARZ3NDEKTSV4RRFFQ69G5FAV",
            webUrl:
              "https://app.zapp.build/projects/proj_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          },
        ],
        reconnectAfterMs: 1_000,
      })
      .mockResolvedValueOnce({
        nextCursor: 4,
        notifications: [],
        reconnectAfterMs: 1_000,
      });
    const show = vi.fn(async () => true);
    const scheduled: Array<() => void> = [];
    const delivery = createDesktopNotificationDelivery({
      deviceId: "device-1",
      organizationId: "org_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      request,
      schedule(callback) {
        scheduled.push(callback);
        return callback;
      },
      cancel: vi.fn(),
      show,
    });

    delivery.start();
    await vi.waitFor(() => expect(show).toHaveBeenCalledOnce());
    scheduled.shift()?.();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));

    expect(request.mock.calls[1]?.[1]).toMatchObject({ query: { after: 4 } });
    delivery.close();
  });

  it("fails closed on malformed or cross-tenant projections without blocking launch", async () => {
    const show = vi.fn();
    const onError = vi.fn();
    const delivery = createDesktopNotificationDelivery({
      deviceId: "device-1",
      organizationId: "org_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      request: vi.fn(async () => ({
        nextCursor: 1,
        notifications: [
          {
            channel: "desktop_push",
            cursor: 1,
            desktopUrl: "https://evil.example",
            organizationId: "org_01ARZ3NDEKTSV4RRFFQ69G5FAW",
          },
        ],
        reconnectAfterMs: 1_000,
      })),
      schedule: vi.fn(() => 1),
      cancel: vi.fn(),
      show,
      onError,
    });

    delivery.start();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(show).not.toHaveBeenCalled();
    delivery.close();
  });
});
