'use client';

const memoryHandoffs = new Map<string, string>();

export function rememberFirstPrompt(projectId: string, prompt: string): void {
  memoryHandoffs.set(projectId, prompt);
  try {
    window.sessionStorage.setItem(projectId, prompt);
  } catch {
    // The in-memory handoff still survives the client-side builder navigation.
  }
}

export function readFirstPrompt(projectId: string): string | undefined {
  const memoryPrompt = memoryHandoffs.get(projectId);
  if (memoryPrompt !== undefined && memoryPrompt.length > 0) return memoryPrompt;

  try {
    const prompt = window.sessionStorage.getItem(projectId);
    return prompt === null || prompt.length === 0 ? undefined : prompt;
  } catch {
    return undefined;
  }
}
