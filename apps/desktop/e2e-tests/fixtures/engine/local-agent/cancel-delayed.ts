import type { LocalAgentFixture } from "../../../../testing/fake-llm-server/localAgentTypes";

export const fixture: LocalAgentFixture = {
  description: "Keep a contained gateway turn open until cancellation",
  turns: [
    {
      delayMs: 30_000,
      text: "This delayed response should never be emitted after cancellation.",
    },
  ],
};
