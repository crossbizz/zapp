export {};

declare const unknown: boolean;
const provider = '@ai-sdk/openai';
const loads = [0].flatMap(() => (unknown ? [console.log] : require));
loads[0](provider);
