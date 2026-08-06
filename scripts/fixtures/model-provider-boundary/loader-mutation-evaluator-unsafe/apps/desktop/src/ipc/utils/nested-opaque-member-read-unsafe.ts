export {};

declare function opaque(value: unknown): void;

const provider = '@ai-sdk/openai';
const slots = [console.log, require];
const holder = { slots };
const root = { holder };
opaque(slots);
root.holder.slots[0](provider);
