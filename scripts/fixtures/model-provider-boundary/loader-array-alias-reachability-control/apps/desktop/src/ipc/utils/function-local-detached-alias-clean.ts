export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
function mutate() {
  let alias = slots;
  alias = [];
  alias.unshift(require);
}
mutate();
slots[0](provider);
