export {};

declare function mutate(this: { slots: unknown[] }): void;

const provider = '@ai-sdk/openai';
const slots = [console.log, require];
const holder = { slots, mutate };
holder.mutate();
slots[0](provider);
