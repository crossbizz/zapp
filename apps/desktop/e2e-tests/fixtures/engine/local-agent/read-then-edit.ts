import type { LocalAgentFixture } from "../../../../testing/fake-llm-server/localAgentTypes";

export const fixture: LocalAgentFixture = {
  description: "Edit a file with the contained write_file tool",
  turns: [
    {
      text: "I'll update the welcome message to say UPDATED imported app instead.",
      toolCalls: [
        {
          name: "write_file",
          args: {
            path: "src/App.tsx",
            content:
              "const App = () => <div>UPDATED imported app</div>;\n\nexport default App;\n",
          },
        },
      ],
    },
    {
      text: "Done! I've updated the title from 'Minimal imported app' to 'UPDATED imported app'. The change has been applied successfully.",
    },
  ],
};
