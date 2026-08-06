export {};

const provider = '@ai-sdk/openai';
function disarm() {
  loads[1] = console.info;
}
const loads = [disarm, require];
const copies = loads.map((load) => {
  load();
  return load;
});
copies[1](provider);
