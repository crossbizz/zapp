import { ProjectSettings } from '../../../../../components/settings/ProjectSettings';
export default async function Page({ params }: { readonly params: Promise<{ readonly id: string }> }) { return <ProjectSettings projectId={(await params).id} section="members" />; }
