export const MODEL_FACING_PROMPT_MAX_CHARS = 66_100;

export function modelPromptWithPriorConversationContext(input: {
  readonly prompt: string;
  readonly priorConversationContext?: string | undefined;
}): string {
  if (input.priorConversationContext === undefined) return input.prompt;
  return `${input.priorConversationContext}\n\nCurrent request:\n${input.prompt}`;
}
