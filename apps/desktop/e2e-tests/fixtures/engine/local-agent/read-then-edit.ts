import type { LocalAgentFixture } from "../../../../testing/fake-llm-server/localAgentTypes";

export const fixture: LocalAgentFixture = {
  description: "Read a file, then edit it with apply_patch",
  turns: [
    {
      text: "Let me first read the current file contents to understand what we're working with.",
      toolCalls: [
        {
          name: "read_file",
          args: {
            path: "src/App.tsx",
          },
        },
      ],
    },
    {
      text: "Now I'll update the welcome message to say UPDATED imported app instead.",
      toolCalls: [
        {
          name: "apply_patch",
          args: {
            patch:
              "--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1,3 +1,3 @@\n-const App = () => <div>Minimal imported app</div>;\n+const App = () => <div>UPDATED imported app</div>;\n \n export default App;\n",
          },
        },
      ],
    },
    {
      text: "Done! I've updated the title from 'Minimal imported app' to 'UPDATED imported app'. The change has been applied successfully.",
    },
  ],
};
