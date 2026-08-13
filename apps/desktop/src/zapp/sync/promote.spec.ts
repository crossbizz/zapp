// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  LocalProjectPromotion,
  type PromotionPort,
  type PromotionState,
  type PromotionStore,
} from "./promote";

describe("LocalProjectPromotion", () => {
  it("resumes after every durable step with one fingerprint identity", async () => {
    let saved: PromotionState | undefined;
    const store: PromotionStore = {
      load: vi.fn(async () => saved),
      save: vi.fn(async (state) => {
        saved = state;
      }),
    };
    const port: PromotionPort = {
      fingerprint: vi.fn(async () => "sha256:local-project"),
      createCloudProject: vi.fn(async () => "proj_cloud"),
      pushRepository: vi.fn(async () => undefined),
      scanCapabilities: vi.fn(async () => undefined),
      bootWorkspace: vi.fn(async () => "ws_cloud"),
      markLinked: vi.fn(async () => undefined),
    };

    for (const expected of [
      "cloud_created",
      "repository_pushed",
      "capabilities_scanned",
      "workspace_booted",
      "linked",
      "done",
    ] as const) {
      const promotion = new LocalProjectPromotion("local_1", store, port, {
        stopAfter: expected,
      });
      saved = await promotion.run();
      expect(saved.phase).toBe(expected);
    }

    expect(port.createCloudProject).toHaveBeenCalledTimes(1);
    expect(port.createCloudProject).toHaveBeenCalledWith({
      fingerprint: "sha256:local-project",
      operationKey: "promote:sha256:local-project",
    });
    expect(port.pushRepository).toHaveBeenCalledTimes(1);
    expect(port.scanCapabilities).toHaveBeenCalledTimes(1);
    expect(port.bootWorkspace).toHaveBeenCalledTimes(1);
    expect(port.markLinked).toHaveBeenCalledTimes(1);
    expect(saved).toMatchObject({
      phase: "done",
      cloudProjectId: "proj_cloud",
      workspaceId: "ws_cloud",
    });
  });
});
