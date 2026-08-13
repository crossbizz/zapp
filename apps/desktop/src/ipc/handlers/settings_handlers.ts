import { createTypedHandler } from "./base";
import { settingsContracts } from "../types/settings";
import { writeSettings, readEffectiveSettings } from "../../main/settings";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";

export function registerSettingsHandlers() {
  // Note: Settings handlers intentionally use createTypedHandler without logging
  // to avoid logging sensitive data (API keys, tokens, etc.) from args/return values.

  createTypedHandler(settingsContracts.getUserSettings, async () => {
    return readEffectiveSettings();
  });

  createTypedHandler(settingsContracts.setUserSettings, async (_, settings) => {
    writeSettings(settings);
    return readEffectiveSettings();
  });

  createTypedHandler(settingsContracts.validateProviderApiKey, async () => {
    throw new DyadError(
      "Desktop model traffic uses the authenticated zapp platform; direct provider keys are disabled.",
      DyadErrorKind.Precondition,
    );
  });
}
