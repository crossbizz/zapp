export {};

const provider = '@ai-sdk/anthropic';
const box: any[] = [require];

box.unshift(console.log);
box[1](provider).createAnthropic({});
