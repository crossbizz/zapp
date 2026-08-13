import { ReleasesView } from '../../../../../components/releases/ReleasesView';
export default async function Page({ params }: { readonly params: Promise<{ readonly id: string; readonly releaseId: string }> }) { const value = await params; return <ReleasesView projectId={value.id} releaseId={value.releaseId} />; }
