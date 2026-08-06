export {};

declare const condition: boolean;

const provider = '@ai-sdk/openai';
const slots = [console.log];
const box = condition
  ? {
      set value(_value: unknown[]) {},
    }
  : { value: [] as unknown[] };
box.value = slots;
box.value.unshift(require);
slots[0](provider);
