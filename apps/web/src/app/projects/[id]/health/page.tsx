import type { ReactElement } from 'react';
import { ProductionHealthView } from '../../../../components/releases/ProductionHealthView';

export default async function Page({ params }: { readonly params: Promise<{ readonly id: string }> }): Promise<ReactElement> {
  const { id } = await params; return <ProductionHealthView projectId={id} />;
}
