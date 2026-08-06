export {};

declare const mutate: (value: unknown[]) => void;
const slots = [console.info, require];
globalThis.console.log = mutate;
console.log(slots);
slots[0]('@ai-sdk/openai');
