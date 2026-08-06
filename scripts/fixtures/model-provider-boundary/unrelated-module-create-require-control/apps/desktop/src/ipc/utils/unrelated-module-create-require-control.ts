import * as Module from './module-wrapper';

const key = 'create' + 'Require';
Module[key](import.meta.url)('@ai-sdk/openai').createOpenAI();
