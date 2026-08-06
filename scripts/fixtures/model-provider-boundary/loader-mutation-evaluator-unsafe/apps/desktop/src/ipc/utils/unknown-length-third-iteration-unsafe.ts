export {};

declare const values: number[];
const slots = [console.info];
let first = false;
let second = false;
values.forEach(() => {
  if (second) slots.unshift(require);
  second = first;
  first = true;
});
slots[0]('@ai-sdk/openai');
