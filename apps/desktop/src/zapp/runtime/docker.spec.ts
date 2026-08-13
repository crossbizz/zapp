// @vitest-environment node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DockerWorkspaceRuntime,
  FORGE_NODE_BASE_IMAGE,
  probeDockerAvailability,
  type DockerCommandRunner,
} from "./docker";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("DockerWorkspaceRuntime", () => {
  it("uses the digest-pinned public forge image, bind mount, and docker exec", async () => {
    const root = await mkdtemp(join(tmpdir(), "zapp-docker-runtime-"));
    roots.push(root);
    await writeFile(join(root, "hello.txt"), "hello");
    const calls: string[][] = [];
    const runner: DockerCommandRunner = {
      run: vi.fn(async (args) => {
        calls.push([...args]);
        return {
          exitCode: args[0] === "inspect" ? 1 : 0,
          stdout: "ok",
          stderr: "",
          durationMs: 1,
          truncated: false,
        };
      }),
      stream: vi.fn(async function* () {}),
    };
    const runtime = new DockerWorkspaceRuntime(root, {
      runner,
      containerName: "zapp-test",
    });

    expect(runtime.kind).toBe("docker");
    await expect(runtime.readFile("hello.txt")).resolves.toEqual(
      new TextEncoder().encode("hello"),
    );
    await runtime.exec({
      cmd: "node",
      args: ["--version"],
      cwd: "src",
      timeoutMs: 2_000,
    });

    expect(calls[1]).toEqual(
      expect.arrayContaining([
        "run",
        "-d",
        "--name",
        "zapp-test",
        "--mount",
        `type=bind,source=${root},target=/workspace`,
        FORGE_NODE_BASE_IMAGE,
      ]),
    );
    expect(calls[2]).toEqual([
      "exec",
      "-w",
      "/workspace/src",
      "zapp-test",
      "node",
      "--version",
    ]);
    expect(FORGE_NODE_BASE_IMAGE).toMatch(
      /^ghcr\.io\/crossbizz\/.+@sha256:[a-f0-9]{64}$/u,
    );
  });

  it("reports unavailable Docker without throwing", async () => {
    const runner: DockerCommandRunner = {
      run: vi.fn(async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "daemon unavailable",
        durationMs: 1,
        truncated: false,
      })),
      stream: vi.fn(async function* () {}),
    };
    await expect(probeDockerAvailability(runner)).resolves.toEqual({
      available: false,
      diagnosticsUrl: "https://docs.docker.com/desktop/troubleshoot/",
      reason: "daemon unavailable",
    });
  });
});
