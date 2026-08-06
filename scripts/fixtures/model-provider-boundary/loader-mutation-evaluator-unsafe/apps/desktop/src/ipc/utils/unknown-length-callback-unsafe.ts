export {};

declare const values: number[];
const slots = [console.info];
let alias: unknown[] = [];
values.forEach(() => {
  alias = slots;
});
alias.unshift(require);
slots[0]('@ai-sdk/openai');
