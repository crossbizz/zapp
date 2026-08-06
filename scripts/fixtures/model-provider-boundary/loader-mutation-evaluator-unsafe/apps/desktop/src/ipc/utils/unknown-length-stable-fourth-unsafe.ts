export {};

declare const values: number[];
const slots = [console.info];
const flags = { first: false, second: false, third: false };

values.forEach(() => {
  if (flags.third) slots.unshift(require);
  flags.third = flags.second;
  flags.second = flags.first;
  flags.first = true;
});
slots[0]('@ai-sdk/openai');
