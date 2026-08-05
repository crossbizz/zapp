export {};

let assign;
({ assign } = Object);
const box = { load: console.log };

assign(box, { inspect: console.info });
box.load('@ai-sdk/openai');
box.inspect('@ai-sdk/anthropic');
