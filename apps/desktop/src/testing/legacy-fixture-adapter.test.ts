import { describe, expect, it } from "vitest";

import {
  adaptLegacyFixtureMarkdown,
  extractHybridFixtureTrigger,
  hybridFixtureTurnIndex,
  hybridFixtureUsage,
  loadLegacyFixtureTurnsForTesting,
  waitForHybridFixtureDelay,
} from "./legacy-fixture-adapter";

describe("legacy hybrid fixture adapter", () => {
  it("maps dyad-write through the contained write_file tool and retains the fixture response", () => {
    const fixture = `BEFORE TAG
<dyad-write path="src/foo/bar.tsx" description="page to use <a> and <b> tags.">
// BEGINNING OF FILE
</dyad-write>
AFTER TAG`;

    expect(adaptLegacyFixtureMarkdown(fixture)).toEqual([
      {
        toolCalls: [
          {
            name: "write_file",
            args: {
              path: "src/foo/bar.tsx",
              content: "// BEGINNING OF FILE",
            },
          },
        ],
      },
      { text: fixture },
    ]);
  });

  it("keeps a text-only fixture as one terminal gateway turn", () => {
    expect(adaptLegacyFixtureMarkdown("No file changes.\n")).toEqual([
      { text: "No file changes.\n" },
    ]);
  });

  it("distinguishes current local-agent fixtures from safe legacy markdown fixtures", () => {
    expect(
      extractHybridFixtureTrigger([
        { role: "user", content: [{ type: "text", text: "tc=write-index" }] },
      ]),
    ).toEqual({ kind: "legacy", name: "write-index", operation: "user:0" });
    expect(
      extractHybridFixtureTrigger([
        {
          role: "user",
          content: [{ type: "text", text: "tc=local-agent/simple-response" }],
        },
      ]),
    ).toEqual({
      kind: "local-agent",
      name: "simple-response",
      operation: "user:0",
    });
    expect(() =>
      extractHybridFixtureTrigger([
        { role: "user", content: [{ type: "text", text: "tc=../.env" }] },
      ]),
    ).toThrow("safe tc=<fixture> trigger");
    expect(
      extractHybridFixtureTrigger([{ role: "user", content: "[increment]" }]),
    ).toEqual({ kind: "counter", name: "increment", operation: "user:0" });
    expect(
      extractHybridFixtureTrigger([
        { role: "user", content: "Summarize from chat-id=42" },
      ]),
    ).toEqual({ kind: "summary", name: "chat-42", operation: "user:0" });
  });

  it("selects the latest exact user operation and ignores assistant or system text", () => {
    expect(
      extractHybridFixtureTrigger([
        { role: "system", content: "example tc=ignored" },
        { role: "user", content: "tc=write-index" },
        { role: "assistant", content: "quoted tc=wrong" },
        { role: "tool", content: [] },
        { role: "user", content: [{ type: "text", text: "tc=write-index-2" }] },
      ]),
    ).toEqual({
      kind: "legacy",
      name: "write-index-2",
      operation: "user:4",
    });
    expect(() =>
      extractHybridFixtureTrigger([
        { role: "system", content: "tc=write-index" },
        { role: "user", content: "please use tc=write-index as an example" },
      ]),
    ).toThrow("safe tc=<fixture> trigger");
    expect(() =>
      extractHybridFixtureTrigger([
        { role: "user", content: "tc=write-index" },
        { role: "assistant", content: "done" },
        { role: "user", content: "hi" },
      ]),
    ).toThrow("safe tc=<fixture> trigger");
  });

  it("loads an existing markdown fixture from the fixed fixture root", () => {
    const turns = loadLegacyFixtureTurnsForTesting("dyad-write-angle");
    expect(turns[0]?.toolCalls).toEqual([
      {
        name: "write_file",
        args: {
          path: "src/foo/bar.tsx",
          content: "// BEGINNING OF FILE",
        },
      },
    ]);
    expect(turns.at(-1)?.text).toContain("AFTER TAG");
  });

  it("rejects unsupported and malformed legacy mutation tags", () => {
    expect(() =>
      adaptLegacyFixtureMarkdown(
        '<dyad-delete path="src/App.tsx"></dyad-delete>',
      ),
    ).toThrow("unsupported legacy mutation tag");
    expect(() =>
      adaptLegacyFixtureMarkdown('<dyad-write path="src/App.tsx">unterminated'),
    ).toThrow("malformed dyad-write tag");
  });

  it("rejects traversal paths before emitting a contained tool call", () => {
    expect(() =>
      adaptLegacyFixtureMarkdown(
        '<dyad-write path="../outside.ts">outside</dyad-write>',
      ),
    ).toThrow("unsafe workspace path");
    expect(() =>
      adaptLegacyFixtureMarkdown(
        '<dyad-write path="C:\\\\outside.ts">outside</dyad-write>',
      ),
    ).toThrow("unsafe workspace path");
    expect(() =>
      adaptLegacyFixtureMarkdown(
        '<dyad-write path=".git/config">outside</dyad-write>',
      ),
    ).toThrow("unsafe workspace path");
    expect(() =>
      adaptLegacyFixtureMarkdown(
        '<dyad-write path=".GIT/hooks/new-hook">outside</dyad-write>',
      ),
    ).toThrow("unsafe workspace path");
  });

  it("rejects conflicting writes before emitting any tool calls", () => {
    expect(() =>
      adaptLegacyFixtureMarkdown(
        [
          '<dyad-write path="src/App.tsx">one</dyad-write>',
          '<dyad-write path="src/App.tsx">two</dyad-write>',
        ].join("\n"),
      ),
    ).toThrow("duplicate workspace path");
    expect(() =>
      adaptLegacyFixtureMarkdown(
        [
          '<dyad-write path="src/App.tsx">one</dyad-write>',
          '<dyad-write path="src/./App.tsx">two</dyad-write>',
        ].join("\n"),
      ),
    ).toThrow("duplicate workspace path");
    expect(() =>
      adaptLegacyFixtureMarkdown(
        [
          '<dyad-write path="src/App.tsx">one</dyad-write>',
          '<dyad-write path="SRC/app.tsx">two</dyad-write>',
        ].join("\n"),
      ),
    ).toThrow("duplicate workspace path");
  });

  it("derives the fixture turn from tool activity after the current user operation", () => {
    const initial = [
      { role: "system", content: "system" },
      { role: "user", content: "tc=write-index" },
    ];
    expect(hybridFixtureTurnIndex(initial, "user:1")).toBe(0);
    expect(
      hybridFixtureTurnIndex(
        [
          ...initial,
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "write_file",
                input: {},
              },
            ],
          },
          { role: "tool", content: [] },
        ],
        "user:1",
      ),
    ).toBe(1);
    expect(
      hybridFixtureTurnIndex(
        [
          ...initial,
          { role: "assistant", content: "old terminal response" },
          { role: "user", content: "tc=write-index" },
        ],
        "user:3",
      ),
    ).toBe(0);
  });

  it("maps typed fixture usage and makes the fixture delay abortable", async () => {
    expect(
      hybridFixtureUsage({
        prompt_tokens: 120,
        completion_tokens: 30,
        total_tokens: 150,
      }),
    ).toEqual({ inputTokens: 120, outputTokens: 30, totalTokens: 150 });
    expect(hybridFixtureUsage(undefined)).toEqual({ totalTokens: 1 });

    const controller = new AbortController();
    const waiting = waitForHybridFixtureDelay(60_000, controller.signal);
    controller.abort();
    await expect(waiting).resolves.toBe(false);
    await expect(waitForHybridFixtureDelay(undefined)).resolves.toBe(true);
  });
});
