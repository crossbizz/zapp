import Link from 'next/link';
import type { ReactElement } from 'react';

export function NewProjectLink(): ReactElement {
  return (
    <Link className="zapp-button zapp-button--primary" href="/dashboard">
      New project
    </Link>
  );
}
