export {};

const provider = '@ai-sdk/openai';
const box: any[] = [console.log];

box.push(require);
box[1](provider).createOpenAI({});
