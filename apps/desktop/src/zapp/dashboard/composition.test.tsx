import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: undefined }));

import { getRegisteredHandlerForTesting } from "@/ipc/handlers/base";
import { VALID_INVOKE_CHANNELS } from "@/ipc/preload/channels";

import { dashboardContracts } from "./contracts";
import { DesktopProjectsDashboard } from "./control";
import { registerCloudDashboardHandlers } from "./handlers";

const project = {
  archivedAt: null,
  createdAt: "2026-08-10T12:00:00.000Z",
  createdBy: "usr_01",
  description: null,
  id: "proj_01",
  name: "Cloud Portal",
  organizationId: "org_alpha",
  slug: "cloud-portal",
  sourceType: "prompt",
  supportLevel: "verified" as const,
};

afterEach(() => {
  cleanup();
  delete (window as Window & { electron?: unknown }).electron;
});

describe("MAC-5 production composition", () => {
  it("whitelists strict main-process dashboard handlers", async () => {
    const api = {
      listProjects: vi.fn(() =>
        Promise.resolve({ items: [project], nextCursor: null }),
      ),
      createProject: vi.fn(() =>
        Promise.resolve({ mode: "cloud" as const, projectId: "proj_02" }),
      ),
      openProject: vi.fn(() =>
        Promise.resolve({ mode: "cloud" as const, projectId: "proj_01" }),
      ),
    };
    registerCloudDashboardHandlers(api);

    for (const contract of Object.values(dashboardContracts)) {
      expect(VALID_INVOKE_CHANNELS).toContain(contract.channel);
    }
    await expect(
      getRegisteredHandlerForTesting(dashboardContracts.listProjects.channel)(
        {} as never,
        { limit: 24 },
      ),
    ).resolves.toEqual({ items: [project], nextCursor: null });
    await expect(
      getRegisteredHandlerForTesting(dashboardContracts.createProject.channel)(
        {} as never,
        {
          operationId: "00000000-0000-4000-8000-000000000003",
          prompt: "Build a customer portal",
          mode: "build",
        },
      ),
    ).resolves.toEqual({ mode: "cloud", projectId: "proj_02" });
  });

  it("loads the unified home through IPC and emits only a cloud-mode handoff", async () => {
    const channels: string[] = [];
    const onOpenCloud = vi.fn();
    const onOpenLocal = vi.fn();
    (window as Window & { electron?: unknown }).electron = {
      ipcRenderer: {
        invoke: (channel: string, input: unknown) => {
          channels.push(channel);
          if (channel === "zapp-auth:snapshot") {
            return Promise.resolve({
              status: "authenticated",
              cloudEnabled: true,
              identity: {
                user: {
                  id: "usr_01",
                  email: "ada@example.test",
                  displayName: "Ada",
                  avatarUrl: null,
                },
                memberships: [
                  {
                    organization: {
                      id: "org_alpha",
                      name: "Alpha",
                      slug: "alpha",
                    },
                    role: "owner",
                    status: "active",
                    allowedModels: [],
                  },
                ],
              },
              selectedOrganizationId: "org_alpha",
            });
          }
          if (channel === "list-apps") {
            return Promise.resolve({
              apps: [
                {
                  id: 7,
                  name: "Local Shop",
                  path: "local-shop",
                  createdAt: new Date("2026-08-10T11:00:00.000Z"),
                  updatedAt: new Date("2026-08-10T11:00:00.000Z"),
                  isFavorite: false,
                  collectionId: null,
                  githubOrg: null,
                  githubRepo: null,
                  githubBranch: null,
                  githubInstallationId: null,
                  preferredEditor: null,
                  supabaseProjectId: null,
                  neonProjectId: null,
                  vercelProjectId: null,
                  vercelTeamId: null,
                  installCommand: null,
                  startCommand: null,
                  testingEnabled: false,
                  resolvedPath: "/tmp/local-shop",
                },
              ],
            });
          }
          if (channel === dashboardContracts.listProjects.channel) {
            return Promise.resolve({ items: [project], nextCursor: null });
          }
          if (channel === dashboardContracts.openProject.channel) {
            expect(input).toEqual({ projectId: "proj_01" });
            return Promise.resolve({ mode: "cloud", projectId: "proj_01" });
          }
          throw new Error(`unexpected IPC channel ${channel}`);
        },
        on: () => () => {},
      },
    };

    render(
      <DesktopProjectsDashboard
        onOpenCloud={onOpenCloud}
        onOpenLocal={onOpenLocal}
      />,
    );

    expect(await screen.findByText("Cloud Portal")).toBeTruthy();
    expect(screen.getByText("Local Shop")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Cloud Portal" }));
    await waitFor(() => {
      expect(onOpenCloud).toHaveBeenCalledWith({
        mode: "cloud",
        projectId: "proj_01",
      });
    });
    expect(channels).toContain("zapp-auth:snapshot");
    expect(channels).toContain("list-apps");
    expect(channels).toContain(dashboardContracts.listProjects.channel);
    expect(JSON.stringify(channels)).not.toContain("access-token");
  });
});
