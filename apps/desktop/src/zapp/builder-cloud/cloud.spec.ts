// @vitest-environment node

import { reduceBuilderEvents } from "@zapp/ui";
import { describe, expect, it, vi } from "vitest";
import { CloudBuilderController, type CloudBuilderTransport } from "./cloud";

const events = [
  { id: "1", type: "run.started", data: { sequence: 1, payload: {} } },
  {
    id: "2",
    type: "message.user",
    data: { sequence: 2, payload: { content: "Build a store" } },
  },
  {
    id: "3",
    type: "approval.requested",
    data: { sequence: 3, payload: { approvalId: "approval_1" } },
  },
] as const;

describe("CloudBuilderController", () => {
  it("projects the exact shared web reducer snapshot and native approval badge", () => {
    let onEvent: ((event: (typeof events)[number]) => void) | undefined;
    const transport: CloudBuilderTransport = {
      subscribe: vi.fn((_runId, observer) => {
        onEvent = observer;
        return { close: vi.fn() };
      }),
      pause: vi.fn(),
      resume: vi.fn(),
      previewUrl: vi.fn(async () => "https://preview.zapp.build/p/ws_1"),
    };
    const setBadge = vi.fn();
    const controller = new CloudBuilderController("run_1", transport, {
      setBadge,
    });
    controller.connect();
    for (const event of events) onEvent?.(event);

    expect(controller.snapshot()).toEqual(reduceBuilderEvents(events));
    expect(setBadge).toHaveBeenLastCalledWith("1");
    expect(
      controller.nativeMenuActions().map((action) => action.label),
    ).toEqual(["Pause run", "Resume run"]);
  });

  it("uses public controls and rejects provider preview URLs", async () => {
    const transport: CloudBuilderTransport = {
      subscribe: vi.fn(() => ({ close: vi.fn() })),
      pause: vi.fn(async () => undefined),
      resume: vi.fn(async () => undefined),
      previewUrl: vi.fn(async () => "https://workspace.modal.run"),
    };
    const controller = new CloudBuilderController("run_1", transport, {
      setBadge: vi.fn(),
    });
    await controller.pause();
    await controller.resume();
    await expect(controller.authenticatedPreviewUrl()).rejects.toThrow(
      "provider preview URLs",
    );
    expect(transport.pause).toHaveBeenCalledWith("run_1");
    expect(transport.resume).toHaveBeenCalledWith("run_1");
  });

  it("attaches and closes the public desktop notification lifecycle", () => {
    const notifications = { close: vi.fn(), start: vi.fn() };
    const controller = new CloudBuilderController(
      "run_1",
      {
        subscribe: vi.fn(() => ({ close: vi.fn() })),
        pause: vi.fn(),
        resume: vi.fn(),
        previewUrl: vi.fn(async () => "https://preview.zapp.build/p/ws_1"),
      },
      { setBadge: vi.fn() },
      notifications,
    );

    controller.connect();
    controller.close();

    expect(notifications.start).toHaveBeenCalledOnce();
    expect(notifications.close).toHaveBeenCalledOnce();
  });
});
