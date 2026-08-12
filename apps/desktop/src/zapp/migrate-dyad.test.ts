import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  detectDyadProjects,
  migrateDyadProject,
  readDyadTranscriptArchive,
} from "./migrate-dyad";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "zapp-dyad-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { force: true, recursive: true })),
  );
});

describe("detectDyadProjects", () => {
  it("returns sorted direct project directories without hidden or symlink entries", async () => {
    const homeDirectory = await temporaryDirectory();
    const legacyHome = path.join(homeDirectory, "dyad-apps");
    await fs.mkdir(path.join(legacyHome, "Second App"), { recursive: true });
    await fs.mkdir(path.join(legacyHome, "first-app"), { recursive: true });
    await fs.mkdir(path.join(legacyHome, ".internal"), { recursive: true });
    await fs.writeFile(path.join(legacyHome, "README.md"), "not a project");
    await fs.symlink(
      path.join(legacyHome, "first-app"),
      path.join(legacyHome, "linked-app"),
    );

    const canonicalLegacyHome = await fs.realpath(legacyHome);
    await expect(detectDyadProjects({ homeDirectory })).resolves.toEqual([
      {
        name: "first-app",
        path: path.join(canonicalLegacyHome, "first-app"),
      },
      {
        name: "Second App",
        path: path.join(canonicalLegacyHome, "Second App"),
      },
    ]);
  });
});

describe("readDyadTranscriptArchive", () => {
  it("reads bounded legacy transcript files without interpreting them", async () => {
    const projectPath = await temporaryDirectory();
    const transcriptDirectory = path.join(projectPath, ".dyad", "chats", "7");
    await fs.mkdir(transcriptDirectory, { recursive: true });
    await fs.writeFile(
      path.join(transcriptDirectory, "conversation.md"),
      "user: keep this history",
    );

    await expect(readDyadTranscriptArchive(projectPath)).resolves.toEqual({
      format: "dyad-read-only-transcript-archive-v1",
      files: [
        {
          path: "7/conversation.md",
          text: "user: keep this history",
        },
      ],
    });
  });

  it("refuses a transcript root symlink that escapes the project", async () => {
    const projectPath = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await fs.writeFile(path.join(outside, "secret.md"), "outside secret");
    await fs.mkdir(path.join(projectPath, ".dyad"), { recursive: true });
    await fs.symlink(outside, path.join(projectPath, ".dyad", "chats"));

    await expect(readDyadTranscriptArchive(projectPath)).resolves.toEqual({
      format: "dyad-read-only-transcript-archive-v1",
      files: [],
    });
  });
});

describe("migrateDyadProject", () => {
  it("copies, initializes Git, registers locally, archives history, and offers promotion", async () => {
    const homeDirectory = await temporaryDirectory();
    const sourcePath = path.join(homeDirectory, "dyad-apps", "legacy-app");
    const destinationPath = path.join(homeDirectory, "zapp-apps", "legacy-app");
    await fs.mkdir(path.join(sourcePath, ".dyad", "chats"), {
      recursive: true,
    });
    await fs.writeFile(path.join(sourcePath, "package.json"), "{}");
    await fs.writeFile(
      path.join(sourcePath, ".dyad", "chats", "history.md"),
      "legacy chat",
    );
    const operations: string[] = [];
    const registerLocalProject = vi.fn(async (input) => {
      operations.push(`register:${input.operationId}`);
      return { appId: 41, chatId: 91 };
    });
    const offerCloudPromotion = vi.fn(async ({ appId }) => {
      operations.push(`promote:${String(appId)}`);
    });

    const result = await migrateDyadProject(
      {
        destinationPath,
        homeDirectory,
        name: "Legacy App",
        operationId: "ec3d30b1-7663-4a79-b242-1fca4a6af96b",
        sourcePath,
        strategy: "copy",
      },
      {
        async copyProject(source, destination) {
          operations.push("copy");
          await fs.cp(source, destination, { recursive: true });
        },
        async initializeGit(projectPath) {
          operations.push("git");
          await fs.mkdir(path.join(projectPath, ".git"));
        },
        isGitRepository: async (projectPath) => {
          try {
            return (
              await fs.stat(path.join(projectPath, ".git"))
            ).isDirectory();
          } catch {
            return false;
          }
        },
        offerCloudPromotion,
        registerLocalProject,
      },
    );

    const canonicalDestinationPath = await fs.realpath(destinationPath);
    expect(result).toEqual({
      appId: 41,
      chatId: 91,
      path: canonicalDestinationPath,
      promotionOffered: true,
      transcriptArchived: true,
    });
    expect(operations).toEqual([
      "copy",
      "git",
      "register:ec3d30b1-7663-4a79-b242-1fca4a6af96b",
      "promote:41",
    ]);
    expect(registerLocalProject).toHaveBeenCalledWith({
      name: "Legacy App",
      operationId: "ec3d30b1-7663-4a79-b242-1fca4a6af96b",
      path: canonicalDestinationPath,
      source: "dyad-migration",
    });
    const archive = JSON.parse(
      await fs.readFile(
        path.join(
          destinationPath,
          ".zapp",
          "migrations",
          "dyad-chat-history.json",
        ),
        "utf8",
      ),
    ) as { files: Array<{ text: string }> };
    expect(archive.files[0]?.text).toBe("legacy chat");
  });

  it("adopts an existing Git project without copying or initializing", async () => {
    const homeDirectory = await temporaryDirectory();
    const sourcePath = path.join(homeDirectory, "dyad-apps", "existing");
    await fs.mkdir(path.join(sourcePath, ".git"), { recursive: true });
    const copyProject = vi.fn();
    const initializeGit = vi.fn();

    const result = await migrateDyadProject(
      {
        homeDirectory,
        name: "Existing",
        operationId: "3e383f20-e70b-4d62-8516-73b5630cbb0a",
        sourcePath,
        strategy: "adopt",
      },
      {
        copyProject,
        initializeGit,
        isGitRepository: async () => true,
        registerLocalProject: async () => ({ appId: 2, chatId: 3 }),
      },
    );

    expect(copyProject).not.toHaveBeenCalled();
    expect(initializeGit).not.toHaveBeenCalled();
    expect(result.path).toBe(await fs.realpath(sourcePath));
    expect(result.promotionOffered).toBe(false);
  });

  it("rejects a source outside the legacy home before any mutation", async () => {
    const homeDirectory = await temporaryDirectory();
    const sourcePath = path.join(homeDirectory, "elsewhere", "app");
    await fs.mkdir(path.join(homeDirectory, "dyad-apps"));
    await fs.mkdir(sourcePath, { recursive: true });
    const copyProject = vi.fn();
    const registerLocalProject = vi.fn();

    await expect(
      migrateDyadProject(
        {
          homeDirectory,
          name: "Escaped",
          operationId: "7bafbf35-c3e5-47ab-8642-c063146646e7",
          sourcePath,
          strategy: "adopt",
        },
        {
          copyProject,
          initializeGit: vi.fn(),
          isGitRepository: vi.fn(),
          registerLocalProject,
        },
      ),
    ).rejects.toThrow("direct child");
    expect(copyProject).not.toHaveBeenCalled();
    expect(registerLocalProject).not.toHaveBeenCalled();
  });

  it("rejects a copied destination that resolves inside the source tree", async () => {
    const homeDirectory = await temporaryDirectory();
    const sourcePath = path.join(homeDirectory, "dyad-apps", "legacy");
    const nestedPath = path.join(sourcePath, "nested");
    const destinationPath = path.join(homeDirectory, "zapp-apps", "legacy");
    await fs.mkdir(nestedPath, { recursive: true });
    const registerLocalProject = vi.fn();

    await expect(
      migrateDyadProject(
        {
          destinationPath,
          homeDirectory,
          name: "Legacy",
          operationId: "6e9c6559-9d4a-4975-aa08-757b015968cd",
          sourcePath,
          strategy: "copy",
        },
        {
          async copyProject(_source, destination) {
            await fs.mkdir(path.dirname(destination), { recursive: true });
            await fs.symlink(nestedPath, destination);
          },
          initializeGit: vi.fn(),
          isGitRepository: vi.fn(),
          registerLocalProject,
        },
      ),
    ).rejects.toThrow("resolved into its source tree");
    expect(registerLocalProject).not.toHaveBeenCalled();
  });

  it("keeps transcript and promotion failures from rolling back local import", async () => {
    const homeDirectory = await temporaryDirectory();
    const sourcePath = path.join(homeDirectory, "dyad-apps", "legacy");
    await fs.mkdir(sourcePath, { recursive: true });

    const result = await migrateDyadProject(
      {
        homeDirectory,
        name: "Legacy",
        operationId: "153229a6-e6f7-46cb-82da-f52cbcb1330e",
        sourcePath,
        strategy: "adopt",
      },
      {
        archiveTranscripts: async () => {
          throw new Error("old transcript is corrupt");
        },
        copyProject: vi.fn(),
        initializeGit: vi.fn(),
        isGitRepository: async () => true,
        offerCloudPromotion: async () => {
          throw new Error("cloud offline");
        },
        registerLocalProject: async () => ({ appId: 8, chatId: 9 }),
      },
    );
    expect(result).toEqual({
      appId: 8,
      chatId: 9,
      path: await fs.realpath(sourcePath),
      promotionOffered: false,
      transcriptArchived: false,
    });
  });

  it("can re-archive an adopted project with the same keyed registration", async () => {
    const homeDirectory = await temporaryDirectory();
    const sourcePath = path.join(homeDirectory, "dyad-apps", "retryable");
    await fs.mkdir(path.join(sourcePath, ".git"), { recursive: true });
    await fs.mkdir(path.join(sourcePath, ".dyad", "chats"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(sourcePath, ".dyad", "chats", "history.md"),
      "history",
    );
    const request = {
      homeDirectory,
      name: "Retryable",
      operationId: "a51b64d6-9eb2-4c56-8e2e-1c3e1de3eb63",
      sourcePath,
      strategy: "adopt" as const,
    };
    const ports = {
      copyProject: vi.fn(),
      initializeGit: vi.fn(),
      isGitRepository: async () => true,
      registerLocalProject: async () => ({ appId: 5, chatId: 6 }),
    };

    await expect(migrateDyadProject(request, ports)).resolves.toMatchObject({
      transcriptArchived: true,
    });
    await expect(migrateDyadProject(request, ports)).resolves.toMatchObject({
      transcriptArchived: true,
    });
  });
});
