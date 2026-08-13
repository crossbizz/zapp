import type { LocalAgentFixture } from "../../../../testing/fake-llm-server/localAgentTypes";

export const fixture: LocalAgentFixture = {
  description: "Inspect App.tsx with the contained read_file tool",
  turns: [
    {
      text: "Let me inspect App.tsx through the contained workspace reader.",
      toolCalls: [
        {
          name: "read_file",
          args: { path: "src/App.tsx" },
        },
      ],
    },
    {
      text: "This is a simple React component that renders the Minimal imported app text.",
    },
  ],
};
