export {};

const provider = '@ai-sdk/openai';
function arm() {
  loads[1] = require;
}
const loads = [arm, console.log];
const copies = loads.map((load) => {
  load();
  return load;
});
copies[1](provider);
