import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Card, EnvBadge, SupportLevelBadge } from '@zapp/ui';
import '@zapp/ui/tokens.css';

const root = document.getElementById('root');

if (root === null) {
  throw new Error('Vite smoke root element is missing');
}

createRoot(root).render(
  <StrictMode>
    <Card>
      <EnvBadge environment="preview" />
      <SupportLevelBadge level="verified" />
      <Button>Build app</Button>
    </Card>
  </StrictMode>,
);
