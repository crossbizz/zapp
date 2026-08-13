import type { LocalAgentFixture } from "../../../../testing/fake-llm-server/localAgentTypes";

export const fixture: LocalAgentFixture = {
  description: "Keep a contained turn open while renderer queue controls run",
  turns: [{ delayMs: 10_000, text: "Queue fixture completed." }],
};
