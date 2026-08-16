import { z } from 'zod';

export interface ConversationCodeReferenceInput {
  readonly id: string;
  readonly onConsumed?: (accepted: boolean) => void;
  readonly path: string;
}

const SerializedMessageContextSchema = z
  .object({
    message: z.string(),
    referencedFiles: z.array(z.object({ path: z.string() }).strict()).optional(),
    selectedElements: z.array(z.unknown()).optional(),
  })
  .strict()
  .refine(
    (value) => value.referencedFiles !== undefined || value.selectedElements !== undefined,
    'Serialized message context must contain contextual data',
  );

export interface MergedCodeReferences {
  readonly accepted: readonly boolean[];
  readonly references: readonly string[];
  readonly rejected: boolean;
}

export function mergeCodeReferences(
  current: readonly string[],
  incoming: readonly string[],
  maximum: number,
): MergedCodeReferences {
  const references = [...current];
  const accepted: boolean[] = [];
  let rejected = false;
  for (const path of incoming) {
    if (references.includes(path)) {
      accepted.push(true);
      continue;
    }
    if (references.length >= maximum) {
      accepted.push(false);
      rejected = true;
      continue;
    }
    references.push(path);
    accepted.push(true);
  }
  return { accepted, references, rejected };
}

export function displayMessageContent(content: string): string {
  try {
    const parsed = SerializedMessageContextSchema.safeParse(JSON.parse(content) as unknown);
    return parsed.success ? parsed.data.message : content;
  } catch {
    return content;
  }
}

export function serializeMessageContext(
  message: string,
  referencedFiles: readonly string[],
  selectedElements: readonly unknown[],
): string {
  if (referencedFiles.length === 0 && selectedElements.length === 0) return message;
  return JSON.stringify({
    message,
    ...(referencedFiles.length === 0
      ? {}
      : { referencedFiles: referencedFiles.map((path) => ({ path })) }),
    ...(selectedElements.length === 0 ? {} : { selectedElements }),
  });
}
