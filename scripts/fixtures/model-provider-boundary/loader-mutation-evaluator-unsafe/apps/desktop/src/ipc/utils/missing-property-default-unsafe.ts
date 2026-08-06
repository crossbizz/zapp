export {};

declare const condition: boolean;

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias: unknown[] = [];
function attachSlots() {
  alias = slots;
  return [];
}
const box = condition ? { value: [] as unknown[] } : {};
const { value = attachSlots() } = box;
alias.unshift(require);
slots[0](provider);
void value;
