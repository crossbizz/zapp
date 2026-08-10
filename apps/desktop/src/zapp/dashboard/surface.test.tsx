import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FetchImplementation } from "@zapp/api-client";

import type { PlatformAuthSession } from "../auth/session";
import { createCloudDashboardApi } from "./api";
import { UnifiedProjectDashboard } from "./surface";

const cloudProject = {
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

const betaProject = {
  ...cloudProject,
  id: "proj_02",
  name: "Beta Console",
  organizationId: "org_beta",
  slug: "beta-console",
};

function createdProjectBody() {
  return {
    project: cloudProject,
    branches: [
      {
        id: "br_01",
        organizationId: "org_alpha",
        projectId: cloudProject.id,
        name: "main",
        baseBranchId: null,
        headCommitSha: null,
        status: "active",
      },
    ],
    environments: [],
    repository: {
      defaultBranch: "main",
      externalRepoRef: null,
      id: "repo_01",
      internalRepoRef: "org_alpha/cloud-portal",
      organizationId: "org_alpha",
      projectId: cloudProject.id,
      provider: "forgejo",
      syncPolicy: "internal",
    },
  };
}

function createdRunBody() {
  return {
    run: {
      appType: "web" as const,
      branchId: "br_01",
      completedAt: null,
      id: "run_01",
      mode: "build" as const,
      model: null,
      organizationId: "org_alpha",
      projectId: cloudProject.id,
      startedAt: "2026-08-10T12:01:00.000Z",
      startedBy: "usr_01",
      status: "queued",
    },
  };
}

function response(
  status: number,
  body?: unknown,
): Awaited<ReturnType<FetchImplementation>> {
  const text = body === undefined ? "" : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(
      body === undefined ? {} : { "content-type": "application/json" },
    ),
    body: body === undefined ? null : new ReadableStream<Uint8Array>(),
    text: () => Promise.resolve(text),
  };
}

function authenticatedSession(): PlatformAuthSession {
  return {
    signIn: vi.fn(),
    restoreCached: vi.fn(),
    refresh: vi.fn(),
    restore: vi.fn(),
    signOut: vi.fn(),
    selectOrganization: vi.fn(),
    snapshot: () => ({
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
            organization: { id: "org_alpha", name: "Alpha", slug: "alpha" },
            role: "owner",
            status: "active",
            allowedModels: ["anthropic/claude-sonnet-5"],
          },
        ],
      },
      selectedOrganizationId: "org_alpha",
    }),
    authorizationHeader: () => "Bearer access-token",
    subscribe: () => () => {},
  };
}

afterEach(() => {
  cleanup();
});

describe("MAC-5 cloud dashboard API", () => {
  it("uses the main-process bearer and selected organization for generated list/create/run calls", async () => {
    const requests: Array<{
      body?: unknown;
      headers: Headers;
      method: string;
      path: string;
    }> = [];
    const fetch: FetchImplementation = vi.fn(async (url, init) => {
      requests.push({
        ...(init.body === undefined
          ? {}
          : { body: JSON.parse(init.body) as unknown }),
        headers: init.headers ?? new Headers(),
        method: init.method ?? "GET",
        path: `${url.pathname}${url.search}`,
      });
      if (init.method === "GET")
        return response(200, { items: [cloudProject], nextCursor: null });
      if (url.pathname === "/v1/projects") {
        return response(201, createdProjectBody());
      }
      return response(201, createdRunBody());
    });
    const api = createCloudDashboardApi({
      auth: authenticatedSession(),
      baseUrl: "https://api.example.test",
      fetch,
    });

    await expect(api.listProjects({ limit: 24 })).resolves.toEqual({
      items: [cloudProject],
      nextCursor: null,
    });
    await expect(
      api.createProject({
        operationId: "00000000-0000-4000-8000-000000000001",
        prompt: "Build a customer portal",
        mode: "build",
      }),
    ).resolves.toEqual({ mode: "cloud", projectId: cloudProject.id });

    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.headers.get("authorization")).toBe("Bearer access-token");
      expect(request.headers.get("x-organization-id")).toBe("org_alpha");
    }
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /v1/projects?limit=24",
      "POST /v1/projects",
      `POST /v1/projects/${cloudProject.id}/runs`,
    ]);
    expect(requests[1]?.headers.get("idempotency-key")).toBe(
      "00000000-0000-4000-8000-000000000001:project",
    );
    expect(requests[2]?.headers.get("idempotency-key")).toBe(
      "00000000-0000-4000-8000-000000000001:run",
    );
  });

  it.each(["project", "run"] as const)(
    "replays the same project and run keys after an ambiguous %s response",
    async (ambiguousStep) => {
      const requestKeys: Array<{ path: string; key: string | null }> = [];
      let projectAttempts = 0;
      let runAttempts = 0;
      const fetch: FetchImplementation = vi.fn(async (url, init) => {
        requestKeys.push({
          path: url.pathname,
          key: init.headers?.get("idempotency-key") ?? null,
        });
        if (url.pathname === "/v1/projects") {
          projectAttempts += 1;
          if (ambiguousStep === "project" && projectAttempts === 1) {
            throw new Error("project response lost after commit");
          }
          return response(201, createdProjectBody());
        }
        runAttempts += 1;
        if (ambiguousStep === "run" && runAttempts === 1) {
          throw new Error("run response lost after commit");
        }
        return response(201, createdRunBody());
      });
      const api = createCloudDashboardApi({
        auth: authenticatedSession(),
        baseUrl: "https://api.example.test",
        fetch,
      });
      const operation = {
        operationId: "00000000-0000-4000-8000-000000000002",
        prompt: "Build a customer portal",
        mode: "build" as const,
      };

      await expect(api.createProject(operation)).rejects.toThrow(
        "response lost",
      );
      await expect(api.createProject(operation)).resolves.toEqual({
        mode: "cloud",
        projectId: cloudProject.id,
      });

      const projectKeys = requestKeys
        .filter(({ path }) => path === "/v1/projects")
        .map(({ key }) => key);
      const runKeys = requestKeys
        .filter(({ path }) => path.endsWith("/runs"))
        .map(({ key }) => key);
      expect(new Set(projectKeys)).toEqual(
        new Set(["00000000-0000-4000-8000-000000000002:project"]),
      );
      expect(new Set(runKeys)).toEqual(
        new Set(["00000000-0000-4000-8000-000000000002:run"]),
      );
    },
  );
});

describe("MAC-5 unified project dashboard", () => {
  it("renders Local and Cloud projects and produces a cloud-mode open intent", async () => {
    const onOpenLocal = vi.fn();
    const onOpenCloud = vi.fn();
    const listCloudProjects = vi.fn(() =>
      Promise.resolve({ items: [cloudProject], nextCursor: null }),
    );

    render(
      <UnifiedProjectDashboard
        cloudEnabled
        createCloudProject={vi.fn()}
        listCloudProjects={listCloudProjects}
        localProjects={[{ id: 7, name: "Local Shop", path: "/tmp/local-shop" }]}
        onOpenCloud={onOpenCloud}
        onOpenLocal={onOpenLocal}
        organizationId="org_alpha"
      />,
    );

    expect(await screen.findByText("Cloud Portal")).toBeTruthy();
    expect(screen.getByText("Local Shop")).toBeTruthy();
    expect(screen.getAllByText("Cloud")).toHaveLength(1);
    expect(screen.getAllByText("Local")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Open Cloud Portal" }));
    expect(onOpenCloud).toHaveBeenCalledWith({
      mode: "cloud",
      projectId: "proj_01",
    });
    fireEvent.click(screen.getByRole("button", { name: "Open Local Shop" }));
    expect(onOpenLocal).toHaveBeenCalledWith(7);
  });

  it("routes a home-style prompt through cloud project creation and disables cloud offline", async () => {
    const createCloudProject = vi
      .fn()
      .mockRejectedValueOnce(new Error("ambiguous response"))
      .mockResolvedValueOnce({
        mode: "cloud" as const,
        projectId: "proj_02",
      });
    const onOpenCloud = vi.fn();
    const view = render(
      <UnifiedProjectDashboard
        cloudEnabled
        createCloudProject={createCloudProject}
        listCloudProjects={() =>
          Promise.resolve({ items: [], nextCursor: null })
        }
        localProjects={[]}
        onOpenCloud={onOpenCloud}
        onOpenLocal={vi.fn()}
        organizationId="org_alpha"
      />,
    );

    const submit = screen.getByRole("button", { name: "Create cloud project" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Describe your project"), {
      target: { value: "Build a customer portal" },
    });
    fireEvent.click(submit);
    expect(await screen.findByRole("alert")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Retry project creation" }),
    );
    await waitFor(() => {
      expect(createCloudProject).toHaveBeenCalledTimes(2);
      expect(onOpenCloud).toHaveBeenCalledWith({
        mode: "cloud",
        projectId: "proj_02",
      });
    });
    const first = createCloudProject.mock.calls[0]?.[0];
    const second = createCloudProject.mock.calls[1]?.[0];
    expect(first).toMatchObject({
      prompt: "Build a customer portal",
      mode: "build",
    });
    expect(first?.operationId).toEqual(second?.operationId);
    expect(first?.operationId).toEqual(expect.any(String));

    view.rerender(
      <UnifiedProjectDashboard
        cloudEnabled={false}
        createCloudProject={createCloudProject}
        listCloudProjects={() =>
          Promise.resolve({ items: [], nextCursor: null })
        }
        localProjects={[]}
        onOpenCloud={onOpenCloud}
        onOpenLocal={vi.fn()}
        organizationId="org_alpha"
      />,
    );
    expect(
      screen.getByText("Offline — cloud projects unavailable"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Create cloud project" }),
    ).toBeNull();
  });

  it("keeps a pending creation identity while retrying the cloud project list", async () => {
    const createCloudProject = vi
      .fn()
      .mockRejectedValueOnce(new Error("ambiguous response"))
      .mockResolvedValueOnce({
        mode: "cloud" as const,
        projectId: "proj_02",
      });
    const listCloudProjects = vi
      .fn()
      .mockRejectedValueOnce(new Error("list unavailable"))
      .mockResolvedValueOnce({ items: [], nextCursor: null });

    render(
      <UnifiedProjectDashboard
        cloudEnabled
        createCloudProject={createCloudProject}
        listCloudProjects={listCloudProjects}
        localProjects={[]}
        onOpenCloud={vi.fn()}
        onOpenLocal={vi.fn()}
        organizationId="org_alpha"
      />,
    );

    expect(
      await screen.findByRole("button", { name: "Retry cloud project list" }),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Describe your project"), {
      target: { value: "Build a customer portal" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create cloud project" }),
    );
    expect(
      await screen.findByRole("button", { name: "Retry project creation" }),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Retry cloud project list" }),
    );
    await waitFor(() => expect(listCloudProjects).toHaveBeenCalledTimes(2));
    fireEvent.click(
      screen.getByRole("button", { name: "Retry project creation" }),
    );
    await waitFor(() => expect(createCloudProject).toHaveBeenCalledTimes(2));

    expect(createCloudProject.mock.calls[0]?.[0].operationId).toBe(
      createCloudProject.mock.calls[1]?.[0].operationId,
    );
  });

  it("invalidates in-flight pages and refetches when the selected organization changes", async () => {
    let resolveAlpha:
      | ((page: { items: [typeof cloudProject]; nextCursor: null }) => void)
      | undefined;
    const alphaPage = new Promise<{
      items: [typeof cloudProject];
      nextCursor: null;
    }>((resolve) => {
      resolveAlpha = resolve;
    });
    const listCloudProjects = vi
      .fn()
      .mockImplementationOnce(() => alphaPage)
      .mockResolvedValueOnce({ items: [betaProject], nextCursor: null });
    const props = {
      cloudEnabled: true,
      createCloudProject: vi.fn(),
      listCloudProjects,
      localProjects: [],
      onOpenCloud: vi.fn(),
      onOpenLocal: vi.fn(),
    };
    const view = render(
      <UnifiedProjectDashboard {...props} organizationId="org_alpha" />,
    );
    await waitFor(() => expect(listCloudProjects).toHaveBeenCalledTimes(1));

    view.rerender(
      <UnifiedProjectDashboard {...props} organizationId="org_beta" />,
    );
    expect(await screen.findByText("Beta Console")).toBeTruthy();
    resolveAlpha?.({ items: [cloudProject], nextCursor: null });
    await Promise.resolve();
    expect(screen.queryByText("Cloud Portal")).toBeNull();
  });

  it("rejects a project page whose tenant does not match the requested organization", async () => {
    render(
      <UnifiedProjectDashboard
        cloudEnabled
        createCloudProject={vi.fn()}
        listCloudProjects={() =>
          Promise.resolve({ items: [betaProject], nextCursor: null })
        }
        localProjects={[]}
        onOpenCloud={vi.fn()}
        onOpenLocal={vi.fn()}
        organizationId="org_alpha"
      />,
    );

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("Beta Console")).toBeNull();
  });
});
