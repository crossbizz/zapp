import type { IntegrationCatalogEntry } from './settings-types';

export const INTEGRATION_CATALOG = [
  {
    category: 'source',
    description: 'Import, export, and synchronize a GitHub repository.',
    fields: [],
    provider: 'github',
    title: 'GitHub',
  },
  {
    category: 'data',
    description: 'Connect a Supabase project as the application data service.',
    fields: [
      {
        id: 'accessToken',
        label: 'Access token',
        placeholder: 'Supabase access token',
        secret: true,
      },
      { id: 'projectRef', label: 'Project ref', placeholder: 'Project ref', secret: false },
    ],
    provider: 'supabase',
    title: 'Supabase',
  },
  {
    category: 'data',
    description: 'Connect a Neon project and database.',
    fields: [
      { id: 'apiKey', label: 'API key', placeholder: 'Neon API key', secret: true },
      { id: 'projectId', label: 'Project ID', placeholder: 'Neon project ID', secret: false },
      {
        id: 'databaseName',
        label: 'Database name',
        placeholder: 'Database name',
        secret: false,
      },
    ],
    provider: 'neon',
    title: 'Neon',
  },
  {
    category: 'payments',
    description: 'Connect Stripe to payments inside this generated application.',
    fields: [
      { id: 'apiKey', label: 'API key', placeholder: 'Stripe test API key', secret: true },
      { id: 'accountId', label: 'Account ID', placeholder: 'Stripe account ID', secret: false },
    ],
    provider: 'stripe',
    title: 'Stripe',
  },
  {
    category: 'deployment',
    description: 'Connect a Vercel project as a deployment target.',
    fields: [
      {
        id: 'accessToken',
        label: 'Access token',
        placeholder: 'Vercel access token',
        secret: true,
      },
      { id: 'projectId', label: 'Project ID', placeholder: 'Vercel project ID', secret: false },
      { id: 'projectName', label: 'Project name', placeholder: 'Project name', secret: false },
    ],
    provider: 'vercel',
    title: 'Vercel',
  },
] as const satisfies readonly IntegrationCatalogEntry[];
