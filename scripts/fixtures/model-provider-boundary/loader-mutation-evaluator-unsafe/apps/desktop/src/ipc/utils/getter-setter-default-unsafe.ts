export {};

declare const condition: boolean;

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias: unknown[] = [];
function attachSlots() {
  alias = slots;
  return [];
}
const box = condition
  ? {
      get value() {
        return [];
      },
    }
  : {
      set value(_value: unknown[]) {},
    };
const { value = attachSlots() } = box;
alias.unshift(require);
slots[0](provider);
void value;
