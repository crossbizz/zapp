export {};

declare const mutate: (value: unknown[]) => void;
const slots = [console.info, require];
Array.prototype.forEach = () => mutate(slots);
[0].forEach(() => {});
slots[0]('@ai-sdk/openai');
