export {};

declare const maybe: boolean;
function make(value: unknown[]) {
  let box = value;
  return {
    get: () => box,
    clear: () => {
      if (maybe) box = [];
    },
  };
}

const slots = [console.info];
const armed = make(slots);
armed.clear();
const alias = armed.get();
alias.unshift(require);
slots[0]('@ai-sdk/openai');
