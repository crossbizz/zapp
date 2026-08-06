export {};

declare function opaque(value: unknown): void;

const provider = '@ai-sdk/openai';
const slots = [console.log, require];
const outer: unknown[][] = [];
outer.push(slots);
opaque(slots);
const alias = outer[0];
alias[0](provider);
