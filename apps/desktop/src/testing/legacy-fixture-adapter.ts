import fs from "node:fs";
import path from "node:path";

import type { Turn } from "../../testing/fake-llm-server/localAgentTypes";
import { resolveFixturesDir } from "../../testing/fake-llm-server/paths";
import { cleanFullResponse } from "@/ipc/utils/cleanFullResponse";
import { getDyadWriteTags } from "@/ipc/utils/dyad_tag_parser";

const SAFE_FIXTURE_NAME = /^[a-z0-9][a-z0-9/_-]*$/u;

export type HybridFixtureTrigger = {
  kind: "legacy" | "local-agent";
  name: string;
  operation: `user:${number}`;
};

function userText(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const record = message as { role?: unknown; content?: unknown };
  if (record.role !== "user") return undefined;
  if (typeof record.content === "string") return record.content;
  if (!Array.isArray(record.content)) return undefined;
  const parts = record.content.flatMap((part) => {
    if (typeof part !== "object" || part === null) return [];
    const textPart = part as { type?: unknown; text?: unknown };
    return textPart.type === "text" && typeof textPart.text === "string"
      ? [textPart.text]
      : [];
  });
  return parts.join("");
}

export function extractHybridFixtureTrigger(
  messages: unknown,
): HybridFixtureTrigger {
  if (!Array.isArray(messages)) {
    throw new Error(
      "Hybrid tests must use a safe tc=<fixture> trigger or tc=local-agent/<fixture>",
    );
  }
  let selectedIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (userText(messages[index]) !== undefined) {
      selectedIndex = index;
      break;
    }
  }
  const selectedText = userText(messages[selectedIndex])?.trim();
  const selectedMatch = selectedText?.match(/^tc=([a-z0-9][a-z0-9/_-]*)$/u);
  const selected =
    selectedMatch?.[1] === undefined
      ? undefined
      : { name: selectedMatch[1], index: selectedIndex };
  if (selected === undefined || !SAFE_FIXTURE_NAME.test(selected.name)) {
    throw new Error(
      "Hybrid tests must use a safe tc=<fixture> trigger or tc=local-agent/<fixture>",
    );
  }
  const rawName = selected.name;
  const operation: `user:${number}` = `user:${selected.index}`;
  const localPrefix = "local-agent/";
  if (rawName.startsWith(localPrefix)) {
    const name = rawName.slice(localPrefix.length);
    if (name === "" || !SAFE_FIXTURE_NAME.test(name)) {
      throw new Error(
        "Hybrid tests must use a safe tc=<fixture> trigger or tc=local-agent/<fixture>",
      );
    }
    return { kind: "local-agent", name, operation };
  }
  return { kind: "legacy", name: rawName, operation };
}

export function loadLegacyFixtureTurnsForTesting(name: string): Turn[] {
  if (!SAFE_FIXTURE_NAME.test(name)) {
    throw new Error("Legacy hybrid fixture name is unsafe");
  }
  const fixtureRoot = fs.realpathSync(resolveFixturesDir());
  const candidate = path.join(fixtureRoot, `${name}.md`);
  const resolved = fs.realpathSync(candidate);
  const relative = path.relative(fixtureRoot, resolved);
  if (
    relative === "" ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    !fs.statSync(resolved).isFile()
  ) {
    throw new Error(
      "Legacy hybrid fixture must be a regular file in the fixture root",
    );
  }
  return adaptLegacyFixtureMarkdown(fs.readFileSync(resolved, "utf8"));
}

export function adaptLegacyFixtureMarkdown(fixture: string): Turn[] {
  const normalized = cleanFullResponse(fixture);
  const legacyTags = [
    ...normalized.matchAll(/<\/?dyad-([a-z][a-z0-9-]*)\b/giu),
  ];
  if (legacyTags.some((match) => match[1]?.toLowerCase() !== "write")) {
    throw new Error(
      "Legacy hybrid fixture contains an unsupported legacy mutation tag",
    );
  }
  const writeOpenCount = [...normalized.matchAll(/<dyad-write\b/giu)].length;
  const writeCloseCount = [...normalized.matchAll(/<\/dyad-write\s*>/giu)]
    .length;
  const rawWritePaths = [
    ...normalized.matchAll(/<dyad-write\b[^>]*\bpath="([^"]*)"/giu),
  ].map((match) => match[1] ?? "");
  if (
    writeOpenCount !== writeCloseCount ||
    rawWritePaths.length !== writeOpenCount
  ) {
    throw new Error(
      "Legacy hybrid fixture contains a malformed dyad-write tag",
    );
  }
  const normalizedWritePaths = rawWritePaths.map((writePath) =>
    path.posix.normalize(writePath.replaceAll("\\", "/")),
  );
  const writePathIdentities = normalizedWritePaths.map((writePath) =>
    writePath.toLowerCase(),
  );
  if (new Set(writePathIdentities).size !== writePathIdentities.length) {
    throw new Error(
      "Legacy hybrid fixture contains a duplicate workspace path",
    );
  }
  for (const [index, writePath] of rawWritePaths.entries()) {
    const components = writePath.split(/[\\/]/u);
    if (
      writePath.length === 0 ||
      writePath.includes("\0") ||
      writePath.includes("\\") ||
      path.isAbsolute(writePath) ||
      path.win32.isAbsolute(writePath) ||
      components.includes("..") ||
      components.some((component) => component.toLowerCase() === ".git") ||
      normalizedWritePaths[index] !== writePath
    ) {
      throw new Error(
        "Legacy hybrid fixture contains an unsafe workspace path",
      );
    }
  }
  const writes = getDyadWriteTags(normalized);
  if (writes.length !== writeOpenCount) {
    throw new Error(
      "Legacy hybrid fixture contains a malformed dyad-write tag",
    );
  }
  if (writes.length === 0) {
    return [{ text: fixture }];
  }
  return [
    {
      toolCalls: writes.map((write) => ({
        name: "write_file",
        args: { path: write.path, content: write.content },
      })),
    },
    { text: fixture },
  ];
}
