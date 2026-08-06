export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias: unknown[] = [];
const target = {
  set value(_value: number) {
    alias = slots;
  },
};
Object.assign(target, { value: 0 });
alias.unshift(require);
slots[0](provider);
