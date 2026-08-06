export {};

declare function opaque(value: unknown): void;

const provider = '@ai-sdk/openai';
const slots = [console.log, require];
const holder = { value: [] as unknown[] };
holder.value = slots;
opaque(slots);
const alias = holder.value;
alias[0](provider);
