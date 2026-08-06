import { Card } from '@zapp/ui';
import { SessionHome } from '../components/session-home';
import type { ReactElement } from 'react';

export default function HomePage(): ReactElement {
  return (
    <Card className="zapp-web-ui-consumer">
      <SessionHome />
    </Card>
  );
}
