export {};

declare const maybe: boolean;
const slots = [console.info];

function make() {
  let box: unknown[] = [];
  const get = () => box;
  if (maybe) box = slots;
  return get;
}

const alias = make()();
alias.unshift(require);
slots[0]('@ai-sdk/openai');
