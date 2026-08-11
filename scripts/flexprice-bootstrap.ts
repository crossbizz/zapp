import { readFile } from 'node:fs/promises';

import {
  createFlexpriceCatalogClient,
  PlanCatalogSchema,
  syncFlexpriceCatalog,
} from '../services/control-api/src/usage/flexprice.js';

const apiKey = process.env['FLEXPRICE_API_KEY'];
const baseUrl = process.env['FLEXPRICE_BASE_URL'];
if (apiKey === undefined || apiKey === '' || apiKey === 'replace-me') {
  throw new Error('FLEXPRICE_API_KEY is required');
}
if (baseUrl === undefined || !/^https?:\/\//u.test(baseUrl)) {
  throw new Error('FLEXPRICE_BASE_URL must be an HTTP(S) URL');
}

const plansPath = process.argv[2] ?? new URL('../config/plans.json', import.meta.url);
const plans = PlanCatalogSchema.parse(JSON.parse(await readFile(plansPath, 'utf8')) as unknown);
await syncFlexpriceCatalog(createFlexpriceCatalogClient({ apiKey, baseUrl }), plans);
