import * as Module from 'module';

const suffix = 'Require';
const load = Module[`create${suffix}`](import.meta.url);
load('@ai-sdk/openai').createOpenAI({});
