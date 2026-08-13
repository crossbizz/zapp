import type { AgentEvent } from "@zapp/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createRunNotificationController,
  projectNativeNotification,
} from "./controller";

const ids = {
  event: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  organization: "org_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  project: "proj_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  run: "run_01ARZ3NDEKTSV4RRFFQ69G5FAV",
};

function event(
  type: AgentEvent["type"],
  payload: Record<string, unknown> = {},
  eventId = ids.event,
): AgentEvent {
  return {
    id: eventId,
    runId: ids.run,
    sequence: 1,
    occurredAt: "2026-08-12T12:00:00.000Z",
    organizationId: ids.organization,
    projectId: ids.project,
    type,
    visibility: "user",
    payload,
  };
}

describe("projectNativeNotification", () => {
  it.each([
    ["approval.requested", {}, "approval_requested", "Approval requested"],
    [
      "run.completed",
      { status: "completed" },
      "run_completed",
      "Run completed",
    ],
    [
      "deployment.updated",
      { stage: "go_live", status: "passed" },
      "deploy_succeeded",
      "Deployment live",
    ],
    [
      "deployment.updated",
      { stage: "go_live", status: "failed" },
      "deploy_failed",
      "Deployment failed",
    ],
  ] as const)(
    "projects %s into a tenant-safe native notification",
    (type, payload, preferenceType, title) => {
      expect(projectNativeNotification(event(type, payload))).toEqual({
        body: expect.any(String),
        deepLink: `zapp://project/${ids.project}`,
        eventId: ids.event,
        preferenceType,
        title,
      });
    },
  );

  it("ignores unrelated and non-terminal deployment events", () => {
    expect(projectNativeNotification(event("run.started"))).toBeUndefined();
    expect(
      projectNativeNotification(
        event("deployment.updated", { stage: "build", status: "passed" }),
      ),
    ).toBeUndefined();
  });
});

describe("createRunNotificationController", () => {
  it("validates, deduplicates, and respects the server-backed per-type opt-out", async () => {
    let onEvent:
      | ((input: { data: AgentEvent }) => void | Promise<void>)
      | undefined;
    const close = vi.fn();
    const subscribe = vi.fn((_runId, options) => {
      onEvent = options.onEvent;
      return { close, closed: Promise.resolve() };
    });
    const show = vi.fn();
    const enabled = vi.fn(async (type: string) => type !== "run_completed");
    const controller = createRunNotificationController({
      enabled,
      show,
      subscribe,
    });

    controller.start(ids.run);
    expect(subscribe).toHaveBeenCalledWith(
      ids.run,
      expect.objectContaining({ onEvent: expect.any(Function) }),
    );

    await onEvent?.({ data: event("run.completed", { status: "completed" }) });
    const approval = event(
      "approval.requested",
      {},
      "evt_01ARZ3NDEKTSV4RRFFQ69G5FAW",
    );
    await onEvent?.({ data: approval });
    await onEvent?.({ data: approval });

    expect(enabled).toHaveBeenCalledWith("run_completed");
    expect(enabled).toHaveBeenCalledWith("approval_requested");
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Approval requested" }),
    );

    controller.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("drops malformed event data at the boundary", async () => {
    let onEvent:
      | ((input: { data: unknown }) => void | Promise<void>)
      | undefined;
    const show = vi.fn();
    const controller = createRunNotificationController({
      enabled: async () => true,
      show,
      subscribe: (_runId, options) => {
        onEvent = options.onEvent;
        return { close: vi.fn(), closed: Promise.resolve() };
      },
    });

    controller.start(ids.run);
    await onEvent?.({ data: { type: "approval.requested" } });

    expect(show).not.toHaveBeenCalled();
  });

  it("cannot show an in-flight event after the controller is closed", async () => {
    let onEvent:
      | ((input: { data: AgentEvent }) => void | Promise<void>)
      | undefined;
    let release: (() => void) | undefined;
    const enabled = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = () => resolve(true);
        }),
    );
    const show = vi.fn();
    const controller = createRunNotificationController({
      enabled,
      show,
      subscribe: (_runId, options) => {
        onEvent = options.onEvent;
        return { close: vi.fn(), closed: Promise.resolve() };
      },
    });
    controller.start(ids.run);
    const delivery = onEvent?.({ data: event("approval.requested") });

    controller.close();
    release?.();
    await delivery;

    expect(show).not.toHaveBeenCalled();
  });
});
