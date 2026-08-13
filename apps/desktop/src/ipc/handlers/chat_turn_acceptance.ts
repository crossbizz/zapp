import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, desc, eq, gte, isNull } from "drizzle-orm";

import * as schema from "@/db/schema";
import { chats, messages } from "@/db/schema";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import type { ChatMode, StoredChatMode } from "@/lib/schemas";

type ChatTurnDatabase = Pick<
  BetterSQLite3Database<typeof schema>,
  "transaction"
>;

export interface AcceptChatTurnInput {
  chatId: number;
  storedChatMode: StoredChatMode | null;
  selectedChatMode: ChatMode;
  content: string;
  userInputRequestId?: string;
  redo?: boolean;
}

export interface AcceptedChatTurn {
  userMessageId: number | null;
  authoritativeChatMode: StoredChatMode | null;
}

export function acceptChatTurn(
  database: ChatTurnDatabase,
  input: AcceptChatTurnInput,
): AcceptedChatTurn {
  return database.transaction((tx) => {
    if (input.userInputRequestId !== undefined) {
      const existing = tx
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.chatId, input.chatId),
            eq(messages.userInputRequestId, input.userInputRequestId),
          ),
        )
        .get();
      if (existing !== undefined) {
        tx.update(chats)
          .set({ chatMode: input.selectedChatMode })
          .where(and(eq(chats.id, input.chatId), isNull(chats.chatMode)))
          .run();
        return { userMessageId: null, authoritativeChatMode: null };
      }
    }

    if (input.redo === true) {
      const latestUser = tx
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(eq(messages.chatId, input.chatId), eq(messages.role, "user")),
        )
        .orderBy(desc(messages.id))
        .limit(1)
        .get();
      if (latestUser !== undefined) {
        tx.delete(messages)
          .where(
            and(
              eq(messages.chatId, input.chatId),
              gte(messages.id, latestUser.id),
            ),
          )
          .run();
      }
    }

    const insertedUserMessage = tx
      .insert(messages)
      .values({
        chatId: input.chatId,
        role: "user",
        content: input.content,
        userInputRequestId: input.userInputRequestId,
      })
      .onConflictDoNothing({
        target: [messages.chatId, messages.userInputRequestId],
      })
      .returning({ id: messages.id })
      .get();

    if (!insertedUserMessage) {
      // Repair chats accepted before first-turn latching became atomic.
      tx.update(chats)
        .set({ chatMode: input.selectedChatMode })
        .where(and(eq(chats.id, input.chatId), isNull(chats.chatMode)))
        .run();
      return { userMessageId: null, authoritativeChatMode: null };
    }

    if (input.storedChatMode !== null) {
      return {
        userMessageId: insertedUserMessage.id,
        authoritativeChatMode: null,
      };
    }

    const latchedChat = tx
      .update(chats)
      .set({ chatMode: input.selectedChatMode })
      .where(and(eq(chats.id, input.chatId), isNull(chats.chatMode)))
      .returning({ chatMode: chats.chatMode })
      .get();
    if (latchedChat) {
      return {
        userMessageId: insertedUserMessage.id,
        authoritativeChatMode: latchedChat.chatMode,
      };
    }

    const winningChat = tx
      .select({ chatMode: chats.chatMode })
      .from(chats)
      .where(eq(chats.id, input.chatId))
      .get();
    if (!winningChat) {
      throw new DyadError(
        `Chat not found: ${input.chatId}`,
        DyadErrorKind.NotFound,
      );
    }
    return {
      userMessageId: insertedUserMessage.id,
      authoritativeChatMode: winningChat.chatMode,
    };
  });
}
