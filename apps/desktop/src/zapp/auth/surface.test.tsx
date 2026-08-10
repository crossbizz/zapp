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
import {
  VALID_INVOKE_CHANNELS,
  VALID_RECEIVE_CHANNELS,
} from "@/ipc/preload/channels";

import { PlatformAuthControl } from "./control";
import { platformAuthContracts, platformAuthEvents } from "./contracts";
import { registerPlatformAuthHandlers } from "./handlers";
import type { PlatformAuthSession, PlatformAuthState } from "./session";

const identity = {
  user: {
    id: "user-ada",
    email: "ada@example.test",
    displayName: "Ada Lovelace",
    avatarUrl: null,
  },
  memberships: [
    {
      organization: { id: "org-alpha", name: "Alpha", slug: "alpha" },
      role: "owner" as const,
      status: "active" as const,
      allowedModels: ["anthropic/claude-sonnet-5"],
    },
    {
      organization: { id: "org-beta", name: "Beta", slug: "beta" },
      role: "builder" as const,
      status: "active" as const,
      allowedModels: ["anthropic/claude-sonnet-5"],
    },
  ],
};

afterEach(() => {
  cleanup();
  delete (window as Window & { electron?: unknown }).electron;
});

describe("platform auth Electron surface", () => {
  it("drives sign-in, organization selection, offline restore, and sign-out through typed IPC", async () => {
    let state: PlatformAuthState = { status: "signed-out" };
    const sessionSubscribers = new Set<(next: PlatformAuthState) => void>();
    const rendererListeners = new Map<
      string,
      (payload: PlatformAuthState) => void
    >();
    const session: PlatformAuthSession = {
      signIn: vi.fn(async () => {
        state = {
          status: "authenticated",
          cloudEnabled: true,
          identity,
          selectedOrganizationId: "org-alpha",
        };
        return state;
      }),
      restoreCached: vi.fn(async () => state),
      refresh: vi.fn(async () => state),
      restore: vi.fn(async () => state),
      signOut: vi.fn(async () => {
        state = { status: "signed-out" };
      }),
      selectOrganization: vi.fn(async (organizationId) => {
        state = {
          status: "authenticated",
          cloudEnabled: true,
          identity,
          selectedOrganizationId: organizationId,
        };
        return state;
      }),
      snapshot: vi.fn(() => state),
      authorizationHeader: vi.fn(() => "Bearer main-process-only"),
      subscribe: vi.fn((listener) => {
        sessionSubscribers.add(listener);
        return () => sessionSubscribers.delete(listener);
      }),
    };
    registerPlatformAuthHandlers(session, (next) => {
      rendererListeners.get(platformAuthEvents.stateChanged.channel)?.(next);
    });
    (window as Window & { electron?: unknown }).electron = {
      ipcRenderer: {
        invoke: async (channel: string, input: unknown) =>
          await getRegisteredHandlerForTesting(channel)({} as never, input),
        on: (
          channel: string,
          listener: (payload: PlatformAuthState) => void,
        ) => {
          rendererListeners.set(channel, listener);
          return () => rendererListeners.delete(channel);
        },
      },
    };

    for (const contract of Object.values(platformAuthContracts)) {
      expect(VALID_INVOKE_CHANNELS).toContain(contract.channel);
    }
    expect(VALID_RECEIVE_CHANNELS).toContain(
      platformAuthEvents.stateChanged.channel,
    );

    const view = render(<PlatformAuthControl />);
    expect(
      await screen.findByRole("button", { name: "Sign in to Zapp" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Sign in to Zapp" }));
    expect(
      (
        (await screen.findByLabelText(
          "Active organization",
        )) as HTMLSelectElement
      ).value,
    ).toBe("org-alpha");
    fireEvent.change(screen.getByLabelText("Active organization"), {
      target: { value: "org-beta" },
    });
    await waitFor(() => {
      expect(session.selectOrganization).toHaveBeenCalledWith("org-beta");
      expect(
        (screen.getByLabelText("Active organization") as HTMLSelectElement)
          .value,
      ).toBe("org-beta");
    });

    fireEvent.click(screen.getByRole("button", { name: "Sign out of Zapp" }));
    expect(
      await screen.findByRole("button", { name: "Sign in to Zapp" }),
    ).toBeTruthy();
    expect(session.authorizationHeader).not.toHaveBeenCalled();

    state = {
      status: "offline",
      cloudEnabled: false,
      identity,
      selectedOrganizationId: "org-beta",
    };
    view.unmount();
    render(<PlatformAuthControl />);
    expect(
      await screen.findByText("Offline — cloud features disabled"),
    ).toBeTruthy();
    expect(
      (screen.getByLabelText("Active organization") as HTMLSelectElement).value,
    ).toBe("org-beta");

    state = {
      status: "authenticated",
      cloudEnabled: true,
      identity,
      selectedOrganizationId: "org-alpha",
    };
    for (const subscriber of sessionSubscribers) subscriber(state);
    await waitFor(() => {
      expect(
        screen.queryByText("Offline — cloud features disabled"),
      ).toBeNull();
      expect(
        (screen.getByLabelText("Active organization") as HTMLSelectElement)
          .value,
      ).toBe("org-alpha");
    });
  });
});
