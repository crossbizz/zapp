import { act, renderHook, waitFor } from "@testing-library/react";
import type { RunEvent } from "@zapp/api-client";
import { describe, expect, it, vi } from "vitest";

import { useRunEvents } from "../../../../web/src/hooks/useRunEvents";
import { CloudBuilderController, type CloudBuilderTransport } from "./cloud";

const stream = vi.hoisted(() => ({
  observer: undefined as ((event: RunEvent) => void) | undefined,
}));

vi.mock("../../../../web/src/lib/api", () => ({
  createControlPlaneClient: () => ({
    subscribeRunEvents: (_runId: string, options: { onEvent(event: RunEvent): void }) => {
      stream.observer = options.onEvent;
      return { close: vi.fn(), closed: new Promise<void>(() => undefined) };
    },
  }),
}));

vi.mock("../../../../web/src/lib/activation", () => ({
  captureRunActivation: vi.fn(),
}));

const organizationId = "org_01K27Q9C2W85CMN1V9S6Q3D4FD";
const projectId = "proj_01K27Q9C2W85CMN1V9S6Q3D4FE";
const runId = "run_01K27Q9C2W85CMN1V9S6Q3D4FF";

function event(
  sequence: number,
  type: string,
  payload: Readonly<Record<string, unknown>>,
): RunEvent {
  return {
    id: `evt_${String(sequence)}`,
    type,
    data: {
      id: `evt_${String(sequence)}`,
      occurredAt: `2026-08-13T00:00:0${String(sequence)}.000Z`,
      organizationId,
      payload,
      projectId,
      runId,
      sequence,
      type,
      visibility: "user",
    },
  } as RunEvent;
}

function projectWebClientState(events: readonly RunEvent[]) {
  let deployment:
    | { readonly stage: string; readonly status: "failed" | "passed" | "running"; readonly summary: string }
    | undefined;
  let previewStatus: "failed" | "ready" | "starting" | "unknown" = "unknown";
  let runStatus: "cancelled" | "completed" | "paused" | "running" | "unknown" = "unknown";
  const approvals = new Set<string>();
  const messages: Array<{ readonly role: "assistant" | "user"; readonly content: string }> = [];

  for (const item of events) {
    if (item.type === "run.started" || item.type === "run.resumed") runStatus = "running";
    if (item.type === "run.paused") runStatus = "paused";
    if (item.type === "run.completed") runStatus = "completed";
    if (item.type === "run.cancelled") runStatus = "cancelled";
    if (item.type === "preview.starting") previewStatus = "starting";
    if (item.type === "preview.ready") previewStatus = "ready";
    if (item.type === "preview.failed") previewStatus = "failed";
    if (item.type === "message.user" || item.type === "message.assistant") {
      const content = item.data.payload["content"];
      if (typeof content === "string") {
        messages.push({ role: item.type === "message.user" ? "user" : "assistant", content });
      }
    }
    const approvalId = item.data.payload["approvalId"];
    if (typeof approvalId === "string") {
      if (item.type === "approval.requested") approvals.add(approvalId);
      if (item.type === "approval.resolved") approvals.delete(approvalId);
    }
    if (item.type === "deployment.updated") {
      const { stage, status, summary } = item.data.payload;
      if (
        typeof stage === "string" &&
        (status === "running" || status === "passed" || status === "failed") &&
        typeof summary === "string"
      ) {
        deployment = { stage, status, summary };
      }
    }
  }
  return { approvalIds: [...approvals], deployment, messages, previewStatus, runStatus };
}

describe("web and desktop cloud builder projections", () => {
  it("keeps conversation, preview, Mission Control, and deployment state aligned from one stream", async () => {
    const canonicalEvents = [
      event(1, "run.started", {}),
      event(2, "message.user", { content: "Ship the storefront" }),
      event(3, "message.assistant", { content: "Starting the build." }),
      event(4, "approval.requested", { approvalId: "approval_1" }),
      event(5, "preview.ready", { workspaceId: "ws_1" }),
      event(6, "deployment.updated", {
        stage: "go_live",
        status: "passed",
        summary: "Production is live",
      }),
    ];
    let desktopObserver: ((event: RunEvent) => void) | undefined;
    const transport: CloudBuilderTransport = {
      subscribe: vi.fn((_runId, observer) => {
        desktopObserver = observer as (event: RunEvent) => void;
        return { close: vi.fn() };
      }),
      pause: vi.fn(),
      previewUrl: vi.fn(async () => "https://preview.zapp.build/p/ws_1"),
      resume: vi.fn(),
    };
    const controller = new CloudBuilderController(runId, transport, { setBadge: vi.fn() });
    const web = renderHook(() => useRunEvents(runId, organizationId));

    controller.connect();
    await waitFor(() => expect(stream.observer).toBeTypeOf("function"));
    act(() => {
      for (const item of canonicalEvents) {
        stream.observer?.(item);
        desktopObserver?.(item);
      }
    });

    expect(web.result.current.events).toEqual(canonicalEvents);
    expect(web.result.current.connection).toBe("connected");
    expect(projectWebClientState(web.result.current.events)).toEqual({
      approvalIds: ["approval_1"],
      deployment: {
        stage: "go_live",
        status: "passed",
        summary: "Production is live",
      },
      messages: [
        { role: "user", content: "Ship the storefront" },
        { role: "assistant", content: "Starting the build." },
      ],
      previewStatus: "ready",
      runStatus: "running",
    });
    expect(controller.snapshot()).toEqual(projectWebClientState(web.result.current.events));
  });
});
