export function createRequire() {
  return (target: string) => ({ createOpenAI: () => target });
}
