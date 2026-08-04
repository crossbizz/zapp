/**
 * zapp: pro-removed
 *
 * Process-agnostic replacements for the symbols that upstream Dyad exports from
 * `src/pro/**`. That directory is proprietary (Functional Source License) and is
 * never vendored into this repository, so every import site was repointed here.
 *
 * Everything below is written from scratch against the *call signatures* used by
 * the Apache-2.0 code that remains — no upstream Pro implementation, logic, or
 * text is reproduced. All entry points are inert (feature-off) by design.
 *
 * See docs/adr/0002-dyad-fork.md for the full inventory of stubbed sites.
 */

import type { UserSettings } from "@/lib/schemas";

/** Replaces `@/pro/shared/search_replace_parser`. */
export interface SearchReplaceBlock {
  searchContent: string;
  replaceContent: string;
}

/**
 * Replaces `parseSearchReplaceBlocks` from `@/pro/shared/search_replace_parser`.
 * Turbo Edits is a Pro feature; with it removed there is never a block to parse,
 * so renderers fall back to rendering the raw payload.
 */
export function parseSearchReplaceBlocks(
  _diffContent: string,
): SearchReplaceBlock[] {
  return [];
}

/** Result shape expected by `src/ipc/processors/response_processor.ts`. */
export interface ApplySearchReplaceResult {
  success: boolean;
  content?: string;
  error?: string;
}

/**
 * Replaces `applySearchReplace` from
 * `@/pro/main/ipc/processors/search_replace_processor`. Always reports failure so
 * the caller surfaces a clear "unsupported" issue instead of silently dropping
 * an edit.
 */
export function applySearchReplace(
  _originalContent: string,
  _diffContent: string,
): ApplySearchReplaceResult {
  return {
    success: false,
    error: "search-replace edits are not available in this build",
  };
}

/**
 * Replaces `TURBO_EDITS_V2_SYSTEM_PROMPT` from
 * `@/pro/main/prompts/turbo_edits_v2_prompt`. Empty string == prompt suffix off.
 */
export const TURBO_EDITS_V2_SYSTEM_PROMPT = "";

/**
 * Replaces `isSandboxScriptExecutionEnabled` from
 * `@/pro/main/ipc/handlers/local_agent/tools/execute_sandbox_script`. The sandbox
 * script tool lived in Pro, so the capability hint is always off.
 */
export function isSandboxScriptExecutionEnabled(
  _settings: Pick<UserSettings, "enableSandboxScriptExecution"> | undefined,
): boolean {
  return false;
}

/**
 * Replaces `AgentToolName` from
 * `@/pro/main/ipc/handlers/local_agent/tool_definitions`. Upstream narrows this to
 * a union of the registered Pro tool names; with no tool registry the widened
 * alias keeps every consumer type-checking.
 */
export type AgentToolName = string;
