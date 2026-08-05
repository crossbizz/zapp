export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
function mutate() {
  const alias = slots;
  alias.unshift(require);
}
mutate();
slots[0](provider);
