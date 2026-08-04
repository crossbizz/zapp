/**
 * zapp: pro-removed
 *
 * Main-process replacements for the symbols that upstream Dyad exports from
 * `src/pro/main/**`. Kept separate from `./shared` so the renderer bundle never
 * pulls Electron/IPC modules in transitively.
 *
 * Written from scratch against the call signatures used by the Apache-2.0 code
 * that remains. Every entry point is inert; IPC channels that the UI touches on
 * boot are registered with empty results so the app renders instead of throwing
 * "No handler registered".
 *
 * See docs/adr/0002-dyad-fork.md for the full inventory of stubbed sites.
 */

import type { ModelMessage } from "ai";
import type { IpcMainInvokeEvent } from "electron";
import log from "electron-log";

import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import { createTypedHandler } from "@/ipc/handlers/base";
import { registerTrustedIpcHandler } from "@/ipc/handlers/trusted_handle";
import type { ChatStreamParams } from "@/ipc/types";
import { agentContracts } from "@/ipc/types/agent";
import { templateContracts } from "@/ipc/types/templates";
import type { MentionedAppReference } from "@/ipc/utils/mention_apps";
import type { UserSettings } from "@/lib/schemas";

const logger = log.scope("zapp_pro_stubs");

function unavailable(feature: string): never {
  throw new DyadError(
    `${feature} is not available in this build.`,
    DyadErrorKind.Precondition,
  );
}

// ---------------------------------------------------------------------------
// Replaces `../pro/main/ipc/handlers/themes_handlers`
// ---------------------------------------------------------------------------

/**
 * Themes (built-in + custom + AI theme generation) shipped entirely in Pro.
 * Read paths answer with empty collections; mutating paths reject with a typed
 * precondition error rather than an opaque IPC failure.
 */
export function registerThemesHandlers(): void {
  createTypedHandler(templateContracts.getThemes, async () => []);
  createTypedHandler(templateContracts.getCustomThemes, async () => []);
  createTypedHandler(
    templateContracts.getThemeGenerationModelOptions,
    async () => [],
  );
  createTypedHandler(templateContracts.getAppTheme, async () => null);
  createTypedHandler(templateContracts.setAppTheme, async () => {
    unavailable("Themes");
  });
  createTypedHandler(templateContracts.createCustomTheme, async () => {
    unavailable("Custom themes");
  });
  createTypedHandler(templateContracts.updateCustomTheme, async () => {
    unavailable("Custom themes");
  });
  createTypedHandler(templateContracts.deleteCustomTheme, async () => {
    unavailable("Custom themes");
  });
  createTypedHandler(templateContracts.generateThemePrompt, async () => {
    unavailable("Theme generation");
  });
  createTypedHandler(templateContracts.generateThemeFromUrl, async () => {
    unavailable("Theme generation");
  });
  createTypedHandler(templateContracts.saveThemeImage, async () => {
    unavailable("Theme generation");
  });
  createTypedHandler(templateContracts.cleanupThemeImages, async () => {
    unavailable("Theme generation");
  });
}

// ---------------------------------------------------------------------------
// Replaces `../pro/main/ipc/handlers/visual_editing_handlers`
// ---------------------------------------------------------------------------

/** Visual editing shipped entirely in Pro; both channels reject explicitly. */
export function registerVisualEditingHandlers(): void {
  for (const channel of ["apply-visual-editing-changes", "analyze-component"]) {
    registerTrustedIpcHandler(channel, () => unavailable("Visual editing"));
  }
}

// ---------------------------------------------------------------------------
// Replaces `../pro/main/ipc/handlers/local_agent/agent_tool_handlers`
// ---------------------------------------------------------------------------

/** The local-agent tool registry lived in Pro, so the tool list is empty. */
export function registerAgentToolHandlers(): void {
  createTypedHandler(agentContracts.getTools, async () => []);
  createTypedHandler(agentContracts.setConsent, async () => {
    unavailable("Agent tool consent");
  });
}

// ---------------------------------------------------------------------------
// Replaces `../pro/main/ipc/handlers/local_agent/chat_search_indexer`
// ---------------------------------------------------------------------------

/** Chat-search indexing was Pro-only; there is no index to maintain. */
export function startChatSearchIndexer(): void {}

export function stopChatSearchIndexer(): void {}

export function scheduleChatSearchIndexing(_delayMs?: number): void {}

// ---------------------------------------------------------------------------
// Replaces `../pro/main/ipc/handlers/local_agent/ai_messages_cleanup`
// ---------------------------------------------------------------------------

/** Retention sweep for the Pro agent's on-disk message payloads. */
export function cleanupOldAiMessagesJson(): void {}

// ---------------------------------------------------------------------------
// Replaces `../pro/main/ipc/handlers/local_agent/local_agent_handler`
// ---------------------------------------------------------------------------

export function clearPendingLocalAgentInputsForChat(_chatId: number): void {}

/**
 * Options accepted by {@link handleLocalAgentStream}.
 *
 * Reconstructed from the three call sites in
 * `src/ipc/handlers/chat_stream_handlers.ts` — not copied from the removed Pro
 * module. `readOnly` (ask mode) and `planModeOnly` (plan mode) are each passed
 * by exactly one call site; the rest are passed by all three.
 *
 * This is deliberately a *closed* object type. All three call sites pass a fresh
 * object literal, so excess-property checking makes any upstream change to the
 * argument shape fail `npm run ts` loudly instead of being silently swallowed —
 * which a `...args: unknown[]` rest parameter would do.
 */
export interface LocalAgentStreamOptions {
  placeholderMessageId: number;
  systemPrompt: string;
  dyadRequestId: string;
  /** Ask mode: state-modifying tools disabled, no commits or deploys. */
  readOnly?: boolean;
  /** Plan mode: read-only exploration plus planning tools only. */
  planModeOnly?: boolean;
  messageOverride?: ModelMessage[] | undefined;
  settingsOverride?: UserSettings | undefined;
  freeModelMode?: boolean | undefined;
  referencedApps?: MentionedAppReference[] | undefined;
  currentTurnHasOnDiskAttachment?: boolean | undefined;
}

/**
 * The agent loop itself was Pro. Returning `false` is the upstream "stream did
 * not succeed" signal, which keeps quota accounting and error handling on the
 * paths they already take. zapp replaces this wholesale in MAC-6.
 */
export async function handleLocalAgentStream(
  _event: IpcMainInvokeEvent,
  _req: ChatStreamParams,
  _abortController: AbortController,
  _options: LocalAgentStreamOptions,
): Promise<boolean> {
  logger.warn(
    "Local agent mode is unavailable: the upstream implementation lives in src/pro and is not vendored.",
  );
  return false;
}
