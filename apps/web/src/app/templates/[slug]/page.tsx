import type { ReactElement } from 'react';

import { TemplateDetail } from '../../../components/templates/TemplateDetail';

export default async function TemplatePage({ params }: { readonly params: Promise<{ slug: string }> }): Promise<ReactElement> {
  const { slug } = await params;
  return <TemplateDetail slug={slug} />;
}
