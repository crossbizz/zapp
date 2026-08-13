import type { LocalAgentFixture } from "../../../../testing/fake-llm-server/localAgentTypes";

export const fixture: LocalAgentFixture = {
  description: "Prove ignored .dyad files remain outside the model boundary",
  turns: [
    {
      text: "I'll inspect the model-visible .dyad directory.",
      toolCalls: [
        {
          name: "list_files",
          args: {
            path: ".dyad",
            maxDepth: 100,
          },
        },
      ],
    },
    {
      text: "No ignored .dyad files are visible to the model.",
    },
  ],
};
