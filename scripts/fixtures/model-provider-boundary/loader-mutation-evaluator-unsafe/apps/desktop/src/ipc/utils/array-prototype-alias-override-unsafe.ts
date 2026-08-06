export {};

declare const mutate: (value: unknown[]) => void;
const slots = [console.info, require];
const prototype = Array.prototype;
prototype.forEach = () => mutate(slots);
[0].forEach(() => {});
slots[0]('@ai-sdk/openai');
