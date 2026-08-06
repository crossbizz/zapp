import type { ReactElement } from 'react';

import { Shell } from '../../../components/builder/Shell';

interface ProjectPageProps {
  readonly params: Promise<{ readonly id: string }>;
}

export default async function ProjectPage({ params }: ProjectPageProps): Promise<ReactElement> {
  const { id } = await params;
  return <Shell projectId={id} />;
}
