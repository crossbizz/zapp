import type { LanguageModel } from "ai";

import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import type { LargeLanguageModel, UserSettings } from "@/lib/schemas";

export { setModelClientFetchForTesting } from "./test_fetch_override";

export interface ModelClient {
  model: LanguageModel;
  builtinProviderId?: string;
}

export async function getModelClient(
  _model: LargeLanguageModel,
  _settings: UserSettings,
): Promise<{
  modelClient: ModelClient;
  isEngineEnabled?: boolean;
  isSmartContextEnabled?: boolean;
}> {
  throw new DyadError(
    "Direct desktop model clients are disabled; use the authenticated zapp local-agent session.",
    DyadErrorKind.Precondition,
  );
}
