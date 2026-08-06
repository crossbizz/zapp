export {};

const loads = [console.info, require].filter((_load, index) => (index === 0) === true);
loads[0]('@ai-sdk/openai');
