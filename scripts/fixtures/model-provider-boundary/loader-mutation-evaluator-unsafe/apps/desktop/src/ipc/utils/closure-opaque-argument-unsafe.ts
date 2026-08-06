export {};

declare const mutate: (value: unknown[]) => void;
function make() {
  const slots = [console.info, require];
  return { arm: () => mutate(slots), get: () => slots };
}

const pair = make();
pair.arm();
pair.get()[0]('@ai-sdk/openai');
