export {};

const provider = '@ai-sdk/openai';
function arm() {
  loads[1] = require;
}
const loads = [arm, console.log];
loads.reduce((result, load) => {
  load(provider);
  return result;
}, 0);
