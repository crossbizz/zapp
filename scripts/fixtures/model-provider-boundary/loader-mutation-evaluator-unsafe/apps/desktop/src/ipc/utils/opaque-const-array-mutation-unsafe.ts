export {};

declare function opaque(values: unknown[]): void;

const provider = '@ai-sdk/openai';
const slots = [console.log, require];
opaque(slots);
slots[0](provider);
