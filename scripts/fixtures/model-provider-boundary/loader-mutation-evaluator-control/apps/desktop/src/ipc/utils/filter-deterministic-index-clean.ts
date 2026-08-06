export {};

const loads = [console.info, require].filter((_load, index) => index === 0);
loads[0]('@ai-sdk/openai');
