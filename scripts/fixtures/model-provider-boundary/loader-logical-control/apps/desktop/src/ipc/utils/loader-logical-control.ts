const harmless = () => undefined;
const safeOr = harmless || require;
const safeAnd = false && require;
const safeNullish = harmless ?? require;

safeOr('@ai-sdk/openai');
safeNullish('@ai-sdk/openai');
void safeAnd;
