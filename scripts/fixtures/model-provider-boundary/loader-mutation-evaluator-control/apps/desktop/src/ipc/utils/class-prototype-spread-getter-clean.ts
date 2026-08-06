export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
let alias: unknown[] = [];
class Box {
  get value() {
    alias = slots;
    return 0;
  }
}
const copy = { ...new Box() };
alias.unshift(require);
slots[0](provider);
void copy;
