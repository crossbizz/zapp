// Migrated from e2e-tests/context_compaction.spec.ts, then converted from the
// node chat-flow harness to the HYBRID harness (real <ChatPanel> over the real
// IPC stack). The describe/it names are kept identical to the node version on
// purpose: the existing __snapshots__ transcripts then act as a cross-harness
// equivalence oracle for the UI-driven turns.
//
// Provider-side compaction was removed from the desktop local-agent boundary.
// This file retains the product-valid restore/version cases that do not depend
// on the retired provider-private summary protocol.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  setupHybridChatHarness,
  type HybridChatHarness,
} from "@/testing/hybrid_chat_harness";
import { h } from "@/testing/hybrid.setup";
import { ipc } from "@/ipc/types";
import { chats, messages } from "@/db/schema";
import {
  getCurrentCommitHash,
  gitAddAll,
  gitCheckout,
  gitCommit,
  gitCurrentBranch,
  gitLog,
} from "@/ipc/utils/git_utils";

describe("context compaction (integration)", () => {
  let harness: HybridChatHarness;

  beforeAll(async () => {
    harness = await setupHybridChatHarness({
      electronMock: h,
      engine: true,
      // The e2e picks a non-OpenAI model for local agent mode (OpenAI models
      // go to the responses API); Claude Opus 4.5 comes from the fake catalog.
      selectedModel: { provider: "anthropic", name: "claude-opus-4-5" },
      chatMode: "local-agent",
      settings: {
        isTestMode: true,
        enableDyadPro: true,
        providerSettings: {
          auto: {
            apiKey: { value: "testdyadkey", encryptionType: "plaintext" },
          },
        },
      },
    });
  }, 60_000);

  afterAll(async () => {
    await harness?.dispose();
  });

  const loadChatMessages = (chatId: number) =>
    harness.db.query.messages.findMany({
      where: (messages, { eq }) => eq(messages.chatId, chatId),
      orderBy: (messages, { asc }) => [asc(messages.id)],
    });

  it("restore to the first message forks an empty chat", async () => {
    const initialCommitHash = await getCurrentCommitHash({
      path: harness.appDir,
    });
    const [chatRow] = await harness.db
      .insert(chats)
      .values({
        appId: harness.appId,
        chatMode: "local-agent",
        initialCommitHash,
      })
      .returning();
    const [firstMessage] = await harness.db
      .insert(messages)
      .values({
        chatId: chatRow.id,
        role: "user",
        content: "First prompt",
      })
      .returning();

    const result = await ipc.version.restoreToMessageVersion({
      appId: harness.appId,
      chatId: chatRow.id,
      messageId: firstMessage.id,
      restoreCodebase: true,
    });

    expect(result).toHaveProperty("createdChatId");
    const createdChatId = result.createdChatId ?? -1;
    await expect(loadChatMessages(createdChatId)).resolves.toEqual([]);
    await expect(
      harness.db.query.chats.findFirst({
        where: (chats, { eq }) => eq(chats.id, createdChatId),
      }),
    ).resolves.toMatchObject({
      appId: harness.appId,
      initialCommitHash,
    });
  });

  it("restore to message uses the target branch while previewing detached history", async () => {
    const targetBranchName = await gitCurrentBranch({
      path: harness.appDir,
    });
    expect(targetBranchName).toBeTruthy();

    const initialCommitHash = await getCurrentCommitHash({
      path: harness.appDir,
      ref: targetBranchName!,
    });
    const [chatRow] = await harness.db
      .insert(chats)
      .values({
        appId: harness.appId,
        chatMode: "local-agent",
        initialCommitHash,
      })
      .returning();
    const [firstMessage] = await harness.db
      .insert(messages)
      .values({
        chatId: chatRow.id,
        role: "user",
        content: "First prompt from detached preview",
      })
      .returning();

    await gitCheckout({ path: harness.appDir, ref: initialCommitHash });
    expect(await gitCurrentBranch({ path: harness.appDir })).toBeNull();

    try {
      const result = await ipc.version.restoreToMessageVersion({
        appId: harness.appId,
        chatId: chatRow.id,
        messageId: firstMessage.id,
        restoreCodebase: true,
        targetBranchName: targetBranchName!,
      });

      expect(result).toHaveProperty("createdChatId");
      expect(result.repositoryOutcome).toBe("target-applied");
      await expect(gitCurrentBranch({ path: harness.appDir })).resolves.toBe(
        targetBranchName,
      );
    } finally {
      await gitCheckout({
        path: harness.appDir,
        ref: targetBranchName!,
      }).catch(() => {});
    }
  });

  it("anchors a fork-only chat to the detached preview commit", async () => {
    const targetBranchName = await gitCurrentBranch({ path: harness.appDir });
    expect(targetBranchName).toBeTruthy();
    const chatInitialCommitHash = await getCurrentCommitHash({
      path: harness.appDir,
    });
    const previewFile = path.join(harness.appDir, "detached-preview.txt");
    await fs.promises.writeFile(previewFile, "preview commit\n");
    await gitAddAll({ path: harness.appDir });
    const previewCommitHash = await gitCommit({
      path: harness.appDir,
      message: "Create detached fork preview fixture",
    });
    const [chatRow] = await harness.db
      .insert(chats)
      .values({
        appId: harness.appId,
        chatMode: "local-agent",
        initialCommitHash: chatInitialCommitHash,
      })
      .returning();
    const [firstMessage] = await harness.db
      .insert(messages)
      .values({
        chatId: chatRow.id,
        role: "user",
        content: "Fork from this detached preview",
      })
      .returning();

    await gitCheckout({ path: harness.appDir, ref: previewCommitHash });
    try {
      const result = await ipc.version.restoreToMessageVersion({
        appId: harness.appId,
        chatId: chatRow.id,
        messageId: firstMessage.id,
        restoreCodebase: false,
      });

      expect(result).toHaveProperty("createdChatId");
      expect(result.repositoryOutcome).toBe("unchanged");
      const forkedChat = await harness.db.query.chats.findFirst({
        where: (chat, { eq }) => eq(chat.id, result.createdChatId ?? -1),
      });
      expect(forkedChat?.initialCommitHash).toBe(previewCommitHash);
    } finally {
      await gitCheckout({
        path: harness.appDir,
        ref: targetBranchName!,
      }).catch(() => {});
    }
  });

  it("preflights detached restores and checkpoints dirty preview writes before switching branches", async () => {
    const targetBranchName = await gitCurrentBranch({ path: harness.appDir });
    expect(targetBranchName).toBeTruthy();
    const conflictFile = path.join(harness.appDir, "detached-conflict.txt");
    await fs.promises.writeFile(conflictFile, "restore target\n");
    await gitAddAll({ path: harness.appDir });
    const restoreTargetHash = await gitCommit({
      path: harness.appDir,
      message: "Create detached restore target fixture",
    });
    await fs.promises.writeFile(conflictFile, "live branch\n");
    await gitAddAll({ path: harness.appDir });
    await gitCommit({
      path: harness.appDir,
      message: "Advance detached restore branch fixture",
    });

    const [restoreChat, backgroundChat] = await harness.db
      .insert(chats)
      .values([
        {
          appId: harness.appId,
          chatMode: "local-agent",
          initialCommitHash: restoreTargetHash,
        },
        {
          appId: harness.appId,
          chatMode: "local-agent",
          initialCommitHash: restoreTargetHash,
        },
      ])
      .returning();
    const [restoreMessage] = await harness.db
      .insert(messages)
      .values({
        chatId: restoreChat.id,
        role: "user",
        content: "Restore while detached and dirty",
      })
      .returning();

    await gitCheckout({ path: harness.appDir, ref: restoreTargetHash });
    let backgroundSettled = false;
    const backgroundStream = harness
      .streamChat("tc=local-agent/cancel-delayed", {
        chatId: backgroundChat.id,
      })
      .finally(() => {
        backgroundSettled = true;
      });

    try {
      await vi.waitFor(
        async () => {
          const activeMessages = await harness.db.query.messages.findMany({
            where: (message, { and, eq }) =>
              and(
                eq(message.chatId, backgroundChat.id),
                eq(message.role, "assistant"),
              ),
          });
          expect(activeMessages.length).toBeGreaterThan(0);
        },
        { timeout: 20_000 },
      );
      await fs.promises.writeFile(conflictFile, "interrupted generation\n");

      await expect(
        ipc.version.restoreToMessageVersion({
          appId: harness.appId,
          chatId: restoreChat.id,
          messageId: restoreMessage.id,
          restoreCodebase: true,
        }),
      ).rejects.toThrow("Cannot restore while viewing a historical version");
      expect(backgroundSettled).toBe(false);

      const result = await ipc.version.restoreToMessageVersion({
        appId: harness.appId,
        chatId: restoreChat.id,
        messageId: restoreMessage.id,
        restoreCodebase: true,
        targetBranchName: targetBranchName!,
      });
      await backgroundStream;

      expect(result).toHaveProperty("createdChatId");
      await expect(gitCurrentBranch({ path: harness.appDir })).resolves.toBe(
        targetBranchName,
      );
      await expect(fs.promises.readFile(conflictFile, "utf8")).resolves.toBe(
        "restore target\n",
      );
      const versions = await gitLog({ path: harness.appDir });
      expect(
        versions.some((version) =>
          version.commit.message.includes("Saved partial changes"),
        ),
      ).toBe(true);
    } finally {
      if (!backgroundSettled) {
        await ipc.chat.cancelStream(backgroundChat.id).catch(() => {});
        await backgroundStream.catch(() => {});
      }
      await gitCheckout({
        path: harness.appDir,
        ref: targetBranchName!,
      }).catch(() => {});
    }
  }, 60_000);
});
