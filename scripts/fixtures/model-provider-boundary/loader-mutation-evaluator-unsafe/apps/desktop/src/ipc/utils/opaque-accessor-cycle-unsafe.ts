export {};

declare function opaque(value: unknown): void;

const provider = '@ai-sdk/openai';
const slots = [console.log, require];
let first = true;
const holder = {
  get next(): typeof holder | typeof slots {
    if (first) {
      first = false;
      return holder;
    }
    return slots;
  },
};
opaque(holder);
slots[0](provider);
