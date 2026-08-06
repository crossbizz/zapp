export {};

declare const values: number[];
const slots = [console.info];
values.some((_value, index) => {
  if (index) slots.unshift(require);
  return true;
});
slots[0]('@ai-sdk/openai');
