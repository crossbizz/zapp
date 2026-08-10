// @vitest-environment node

import { createServer } from "node:net";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AtomicWriteConflictError,
  PathViolationError,
} from "@zapp/workspace-runtime";
import type { ExecutionContract } from "@zapp/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { LocalWorkspaceRuntime } from "./local";

const roots: string[] = [];

async function workspace(): Promise<{
  root: string;
  runtime: LocalWorkspaceRuntime;
}> {
  const root = await mkdtemp(join(tmpdir(), "zapp-desktop-local-runtime-"));
  roots.push(root);
  return { root, runtime: new LocalWorkspaceRuntime(root) };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP address");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

function executionContract(command: string, port: number): ExecutionContract {
  return {
    version: 1,
    package_manager: "pnpm",
    workspace_root: ".",
    install: { command: "true" },
    develop: { command, port },
    health: { path: "/" },
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("LocalWorkspaceRuntime", () => {
  it("runs the WS-1 path, timeout, PTY, stream, and truncation contracts", async () => {
    const { root, runtime } = await workspace();
    expect(runtime.kind).toBe("local");

    await mkdir(join(root, "src"));
    await runtime.writeFile("src/app.txt", new TextEncoder().encode("before"));
    await expect(runtime.readFile("src/app.txt")).resolves.toEqual(
      new TextEncoder().encode("before"),
    );
    await expect(runtime.readFile("../outside.txt")).rejects.toBeInstanceOf(
      PathViolationError,
    );

    const outside = join(root, "..", `outside-${String(process.pid)}.txt`);
    await writeFile(outside, "outside");
    await symlink(outside, join(root, "escape-link"));
    await expect(runtime.readFile("escape-link")).rejects.toBeInstanceOf(
      PathViolationError,
    );
    await rm(outside, { force: true });

    const pty = await runtime.exec({
      cmd: process.execPath,
      args: ["-e", "process.stdout.write('pty-ready')"],
      timeoutMs: 2_000,
      pty: true,
    });
    expect(pty).toMatchObject({ exitCode: 0, truncated: false });
    expect(pty.stdout).toContain("pty-ready");

    const timedOut = await runtime.exec({
      cmd: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 100,
    });
    expect(timedOut).toMatchObject({
      exitCode: 124,
      terminationReason: "timeout",
    });

    const truncated = await runtime.exec({
      cmd: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(1100000))"],
      timeoutMs: 5_000,
    });
    expect(truncated.truncated).toBe(true);
    expect(Buffer.byteLength(truncated.stdout, "utf8")).toBeLessThanOrEqual(
      1024 * 1024,
    );

    const iterator = runtime
      .execStream({
        providerWorkspaceId: "local",
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write('first'); setTimeout(() => process.stdout.write('second'), 250)",
        ],
        timeoutMs: 2_000,
      })
      [Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { stream: "stdout", data: "first" },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { stream: "stdout", data: "second" },
    });
  });

  it("excludes inherited host secrets from child processes", async () => {
    const { runtime } = await workspace();
    const inheritedSecretName = "ZAPP_LOCAL_RUNTIME_INHERITED_SECRET";
    process.env[inheritedSecretName] = "must-not-enter-the-child";

    try {
      const inherited = await runtime.exec({
        cmd: process.execPath,
        args: [
          "-e",
          `process.stdout.write(process.env.${inheritedSecretName} ?? "absent")`,
        ],
        timeoutMs: 2_000,
      });
      expect(inherited).toMatchObject({ exitCode: 0, stdout: "absent" });
    } finally {
      delete process.env[inheritedSecretName];
    }
  });

  it("fails guarded writes closed without replacing external edits", async () => {
    const { root, runtime } = await workspace();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "App.tsx"), "external edit\n");

    await expect(
      runtime.readFileForUpdate("src/App.tsx"),
    ).rejects.toBeInstanceOf(AtomicWriteConflictError);
    await expect(
      runtime.writeFilesAtomically([
        {
          path: "src/App.tsx",
          data: new TextEncoder().encode("agent edit\n"),
          expectedRevision: "unsupported-local-revision",
        },
      ]),
    ).rejects.toBeInstanceOf(AtomicWriteConflictError);
    await expect(readFile(join(root, "src", "App.tsx"), "utf8")).resolves.toBe(
      "external edit\n",
    );
  });

  it("bounds PTY timeout settlement and reaps its process tree", async () => {
    const { root, runtime } = await workspace();
    const pidFile = join(root, "pty-pids.json");

    try {
      const script = [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        "process.on('SIGHUP', () => {}); process.on('SIGTERM', () => {});",
        `const child = spawn(${JSON.stringify(process.execPath)}, ["-e", "process.on('SIGHUP', () => {}); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });`,
        `writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ leader: process.pid, child: child.pid }));`,
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const safety = setTimeout(() => {
        void readFile(pidFile, "utf8").then((value) => {
          const parsed = JSON.parse(value) as { leader: number };
          try {
            process.kill(-parsed.leader, "SIGKILL");
          } catch {
            // The runtime may already have reaped the process group.
          }
        });
      }, 2_500);
      const startedAt = performance.now();
      const result = await runtime.exec({
        cmd: process.execPath,
        args: ["-e", script],
        timeoutMs: 1_000,
        pty: true,
      });
      const settledAfterMs = performance.now() - startedAt;
      clearTimeout(safety);
      expect(result).toMatchObject({
        exitCode: 124,
        terminationReason: "timeout",
      });
      expect(settledAfterMs).toBeLessThan(2_000);

      const pids = JSON.parse(await readFile(pidFile, "utf8")) as {
        leader: number;
        child: number;
      };
      for (const pid of [pids.leader, pids.child]) {
        expect(() => process.kill(pid, 0)).toThrow();
      }
    } finally {
      try {
        const pids = JSON.parse(await readFile(pidFile, "utf8")) as {
          leader: number;
        };
        process.kill(-pids.leader, "SIGKILL");
      } catch {
        // The runtime may already have reaped the process group.
      }
    }
  });

  it("commits edits through the bundled Git boundary", async () => {
    const { root, runtime } = await workspace();
    for (const args of [
      ["init"],
      ["config", "user.email", "desktop@example.test"],
      ["config", "user.name", "Desktop Runtime"],
    ]) {
      await expect(
        runtime.exec({ cmd: "git", args, timeoutMs: 5_000 }),
      ).resolves.toMatchObject({ exitCode: 0 });
    }

    await mkdir(join(root, "src"));
    await runtime.writeFile(
      "src/App.tsx",
      new TextEncoder().encode("export const App = 1;\n"),
    );
    await expect(
      runtime.git({
        operation: "add_commit",
        paths: ["src/App.tsx"],
        message: "Update local app",
      }),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      runtime.git({ operation: "log", args: ["--oneline"] }),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("Update local app"),
    });
  });

  it("owns the detected development-server port across restart", async () => {
    const { runtime } = await workspace();
    const port = await availablePort();
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
      `require('node:http').createServer((_request, response) => { response.writeHead(204); response.end(); }).listen(${String(port)}, '127.0.0.1'); setInterval(() => {}, 1000);`,
    )}`;
    let runningPid: number | undefined;

    try {
      const initial = await runtime.startDevServer(
        executionContract(command, port),
      );
      const restarted = await runtime.restartDevServer(
        executionContract(command, port),
      );
      runningPid = restarted.pid;
      expect(restarted.port).toBe(port);
      expect(restarted.pid).not.toBe(initial.pid);
      await expect(runtime.health()).resolves.toMatchObject({ ok: true });
    } finally {
      if (runningPid !== undefined) {
        try {
          process.kill(
            process.platform === "win32" ? runningPid : -runningPid,
            "SIGKILL",
          );
        } catch {
          // The owned process can already have exited after an assertion failure.
        }
      }
    }
  });
});
