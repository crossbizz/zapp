export {};

declare const keepFirst: boolean;
const loads = [console.info, require].filter((_load, index) => {
  if (index) return true;
  return keepFirst;
});
loads[0]('@ai-sdk/openai');
