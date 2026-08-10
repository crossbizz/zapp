import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import type { ProviderApiKeyValidationProvider } from "@/ipc/types";

export async function validateProviderApiKey(_input: {
  provider: ProviderApiKeyValidationProvider;
  apiKey: string;
}): Promise<{ ok: true }> {
  throw new DyadError(
    "Desktop model traffic uses the authenticated zapp platform; direct provider keys are disabled.",
    DyadErrorKind.Precondition,
  );
}
