export {};

declare const condition: boolean;

const provider = '@ai-sdk/openai';
const slots = [console.log];
const box = condition
  ? {
      get value() {
        return [];
      },
    }
  : { value: slots };
const { ...rest } = box;
rest.value.unshift(require);
slots[0](provider);
