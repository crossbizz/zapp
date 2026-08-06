export {};

declare const values: number[];
const slots = [console.info];
values.forEach((_value, index) => {
  if (index) slots.unshift(require);
});
slots[0]('@ai-sdk/openai');
