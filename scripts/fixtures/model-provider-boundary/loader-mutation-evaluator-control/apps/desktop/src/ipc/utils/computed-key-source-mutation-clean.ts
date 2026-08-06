export {};

const provider = '@ai-sdk/openai';
const slots = [console.log];
const box = { value: slots };
function key() {
  box.value = [];
  return 'value';
}
const { [key()]: value } = box;
value.unshift(require);
slots[0](provider);
