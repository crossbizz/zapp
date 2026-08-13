// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  CommitSync,
  ephemeralGitAuth,
  type GitSyncPort,
  type RepositoryLeasePort,
} from "./sync";

function port(overrides: Partial<GitSyncPort> = {}): GitSyncPort {
  return {
    dirtyFiles: vi.fn(async () => []),
    commitAll: vi.fn(async () => undefined),
    stash: vi.fn(async () => undefined),
    discard: vi.fn(async () => undefined),
    fetch: vi.fn(async () => undefined),
    localHead: vi.fn(async () => "local"),
    remoteHead: vi.fn(async () => "remote"),
    mergeBase: vi.fn(async () => "base"),
    fastForward: vi.fn(async () => undefined),
    push: vi.fn(async () => undefined),
    beginMerge: vi.fn(async () => ["src/App.tsx"]),
    completeMerge: vi.fn(async () => "merge_commit"),
    ...overrides,
  };
}

const leases: RepositoryLeasePort = {
  acquire: vi.fn(async () => ({
    cloneUrl: "https://git.zapp.build/acme/app.git",
    username: "lease",
    token: "short-lived-secret",
    expiresAt: "2026-08-12T18:00:00.000Z",
  })),
};

describe("CommitSync", () => {
  it("blocks dirty work until Commit, Stash, or Discard is explicit", async () => {
    const git = port({ dirtyFiles: vi.fn(async () => ["src/App.tsx"]) });
    const sync = new CommitSync("proj_1", git, leases);
    await expect(sync.synchronize()).resolves.toEqual({
      state: "dirty",
      files: ["src/App.tsx"],
      actions: ["commit", "stash", "discard"],
    });
    expect(git.fetch).not.toHaveBeenCalled();
    await sync.synchronize({ dirtyChoice: "stash" });
    expect(git.stash).toHaveBeenCalledOnce();
  });

  it("fast-forwards without discarding either commit", async () => {
    const git = port({ mergeBase: vi.fn(async () => "local") });
    const result = await new CommitSync("proj_1", git, leases).synchronize();
    expect(result).toEqual({
      state: "synchronized",
      action: "fast_forward",
      head: "remote",
    });
    expect(git.fastForward).toHaveBeenCalledWith("remote");
  });

  it("requires an explicit merge commit for divergence", async () => {
    const git = port();
    const sync = new CommitSync("proj_1", git, leases);
    await expect(sync.synchronize()).resolves.toEqual({
      state: "conflicts",
      files: ["src/App.tsx"],
      localHead: "local",
      remoteHead: "remote",
    });
    expect(git.push).not.toHaveBeenCalled();
    await expect(sync.completeMerge(["src/App.tsx"])).resolves.toEqual({
      state: "synchronized",
      action: "merge",
      head: "merge_commit",
    });
    expect(git.completeMerge).toHaveBeenCalledWith(
      ["src/App.tsx"],
      "local",
      "remote",
    );
    expect(git.push).toHaveBeenCalledOnce();
  });

  it("keeps the short-lived token out of the remote and command arguments", () => {
    const auth = ephemeralGitAuth({
      cloneUrl: "https://git.zapp.build/acme/app.git",
      username: "lease",
      token: "short-lived-secret",
      expiresAt: "2026-08-12T18:00:00.000Z",
    });
    expect(auth.remote).not.toContain("short-lived-secret");
    expect(JSON.stringify(auth.environment)).not.toContain(
      "short-lived-secret",
    );
    expect(auth.environment.GIT_CONFIG_VALUE_0).toMatch(
      /^Authorization: Basic /u,
    );
  });
});
