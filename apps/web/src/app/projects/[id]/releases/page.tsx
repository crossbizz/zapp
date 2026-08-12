import { ReleasesView } from '../../../../components/releases/ReleasesView';
export default async function Page({ params }: { readonly params: Promise<{ readonly id: string }> }) { return <ReleasesView projectId={(await params).id} />; }
