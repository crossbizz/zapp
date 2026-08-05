export {};

const provider = '@ai-sdk/openai';

function invokeInCondition(load) {
  if (load(provider)) return true;
  return false;
}

invokeInCondition(require);
