import { expect } from "@playwright/test";
import { testSkipIfWindows } from "./helpers/test_helper";

/**
 * Contained local mode rejects attachments, so its composer must not offer an
 * image-generation action that can only produce an attachment.
 */

testSkipIfWindows(
  "local-agent - generated images unavailable",
  async ({ po }) => {
    await po.setUpDyadPro({ localAgent: true });
    await po.importApp("minimal");
    await po.chatActions.selectLocalAgentMode();

    await po.page.getByTestId("auxiliary-actions-menu").click();
    await expect(po.page.getByTestId("generate-image-menu-item")).toHaveCount(
      0,
    );
  },
);
