export {};

declare function opaque(value: unknown): void;

const provider = '@ai-sdk/openai';
const slots = [console.log, require];
const holder = {
  get slots() {
    return slots;
  },
};
opaque(holder);
slots[0](provider);
