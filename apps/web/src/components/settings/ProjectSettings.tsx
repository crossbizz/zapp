'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactElement } from 'react';

import { createControlPlaneClient, type MeResponse } from '../../lib/api';
import { organizationStorageKey, resolveOrganization } from '../../lib/session';

type Client = ReturnType<typeof createControlPlaneClient>;
type ProjectData = Awaited<ReturnType<Client['getProject']>>;
type SecretsData = Awaited<ReturnType<Client['listProjectSecrets']>>;
type IntegrationsData = Awaited<ReturnType<Client['listIntegrations']>>;
type MembersData = Awaited<ReturnType<Client['listOrganizationMembers']>>;
type GitHubData = Awaited<ReturnType<Client['getGitHubSyncState']>>;
type SettingsData = Awaited<ReturnType<Client['getOrganizationSettings']>>;
type Section = 'general' | 'secrets' | 'integrations' | 'members' | 'github';

const providers = ['github', 'supabase', 'neon', 'stripe', 'vercel'] as const;

function selectedMembership(me: MeResponse) {
  return resolveOrganization(
    me.memberships,
    new URL(globalThis.location.href).searchParams.get('organization'),
    localStorage.getItem(organizationStorageKey(me.user.id)),
  ).membership;
}

export function ProjectSettings({ projectId, section }: { readonly projectId: string; readonly section: Section }): ReactElement {
  const [organizationId, setOrganizationId] = useState<string>();
  const [role, setRole] = useState<'owner' | 'builder' | 'viewer'>();
  const [projectData, setProjectData] = useState<ProjectData>();
  const [secrets, setSecrets] = useState<SecretsData>();
  const [integrations, setIntegrations] = useState<IntegrationsData>();
  const [members, setMembers] = useState<MembersData>();
  const [settings, setSettings] = useState<SettingsData>();
  const [github, setGitHub] = useState<GitHubData>();
  const [status, setStatus] = useState('Loading settings…');
  const canEditProject = role === 'owner' || role === 'builder';
  const isOwner = role === 'owner';

  async function reload(): Promise<void> {
    const me = await createControlPlaneClient().getMe();
    const membership = selectedMembership(me);
    if (membership === undefined) throw new Error('Join an organization to manage this project.');
    const client = createControlPlaneClient(membership.organization.id);
    const project = await client.getProject(projectId);
    setOrganizationId(membership.organization.id);
    setRole(membership.role);
    setProjectData(project);
    if (membership.role !== 'viewer' && section === 'secrets') setSecrets(await client.listProjectSecrets(projectId));
    if (membership.role !== 'viewer' && section === 'github') setGitHub(await client.getGitHubSyncState(projectId));
    if (membership.role === 'owner' && section === 'integrations') setIntegrations(await client.listIntegrations());
    if (membership.role === 'owner' && section === 'members') {
      const [directory, orgSettings] = await Promise.all([
        client.listOrganizationMembers(membership.organization.id), client.getOrganizationSettings(membership.organization.id),
      ]);
      setMembers(directory); setSettings(orgSettings);
    }
    setStatus('');
  }

  useEffect(() => {
    let active = true;
    void reload().catch(() => { if (active) setStatus('Settings could not be loaded.'); });
    return () => { active = false; };
  }, [projectId, section]);

  async function run(work: () => Promise<unknown>, success: string): Promise<void> {
    setStatus('Saving…');
    try { await work(); await reload(); setStatus(success); }
    catch { setStatus('The change could not be saved.'); }
  }

  const client = organizationId === undefined ? undefined : createControlPlaneClient(organizationId);
  const project = projectData?.project;
  const nav = (
    <nav aria-label="Project settings" style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
      {(['general', 'secrets', 'integrations', 'members', 'github'] as const).map((item) => (
        <Link aria-current={section === item ? 'page' : undefined} href={`/projects/${projectId}/settings/${item}`} key={item}>{item[0]?.toUpperCase()}{item.slice(1)}</Link>
      ))}
    </nav>
  );

  return <main style={{ fontFamily: 'system-ui', margin: '0 auto', maxWidth: 920, padding: 32 }}>
    <Link href={`/projects/${projectId}`}>← Back to project</Link>
    <h1>{project?.name ?? 'Project'} settings</h1>
    {nav}
    <p aria-live="polite">{status}</p>

    {section === 'general' && project !== undefined ? <section>
      <h2>General</h2>
      <p>Project slug: <code>{project.slug}</code></p>
      {canEditProject ? <button onClick={() => { if (client !== undefined) void run(() => client.updateProject(projectId, { archived: !project.archivedAt }), project.archivedAt === null ? 'Project archived.' : 'Project restored.'); }} type="button">{project.archivedAt === null ? 'Archive project' : 'Restore project'}</button> : <p>Viewer access is read-only.</p>}
      {isOwner ? <Danger projectId={projectId} projectName={project.name} client={client} onStatus={setStatus} /> : null}
    </section> : null}

    {section === 'secrets' ? <section>
      <h2>Secrets</h2>
      <p>Values are write-only. Saved secrets expose metadata only.</p>
      {canEditProject && client !== undefined ? <SecretForm client={client} environments={projectData?.environments ?? []} projectId={projectId} onSaved={() => reload()} /> : <p>Viewer access is read-only.</p>}
      <ul>{secrets?.items.map((secret) => <li key={secret.id}><strong>{secret.name}</strong> · {secret.environmentId === null ? 'All environments' : secret.environmentId} · version {secret.keyVersion}{canEditProject && client !== undefined ? <RotateSecret client={client} projectId={projectId} secretId={secret.id} onSaved={() => reload()} /> : null}</li>)}</ul>
    </section> : null}

    {section === 'integrations' ? <section>
      <h2>Integrations</h2>
      {!isOwner ? <p>Only Owners can manage integrations.</p> : providers.map((provider) => {
        const connection = integrations?.connections.find((item) => item.provider === provider && (item.projectId === null || item.projectId === projectId));
        return <article key={provider} style={{ border: '1px solid #ddd', margin: '12px 0', padding: 16 }}><h3>{provider[0]?.toUpperCase()}{provider.slice(1)}</h3><p>{connection === undefined ? 'Not connected' : `${connection.status} · ${JSON.stringify(connection.configuration)}`}</p>{connection === undefined ? <IntegrationConnect client={client} projectId={projectId} provider={provider} onSaved={() => reload()} /> : <button onClick={() => { if (client !== undefined) void run(() => client.disconnectIntegration(connection.id), `${provider} disconnected.`); }} type="button">Disconnect</button>}</article>;
      })}
    </section> : null}

    {section === 'members' ? <section>
      <h2>Members</h2>
      {!isOwner || client === undefined || organizationId === undefined ? <p>Only Owners can manage members.</p> : <><InviteForm client={client} organizationId={organizationId} onSaved={() => reload()} /><ul>{members?.members.map((member) => <li key={member.user.id}>{member.user.displayName} ({member.user.email}) <select aria-label={`Role for ${member.user.email}`} onChange={(event) => { void run(() => client.updateOrganizationMember(organizationId, member.user.id, event.target.value as 'owner' | 'builder' | 'viewer'), 'Member role updated.'); }} value={member.role}><option value="owner">Owner</option><option value="builder">Builder</option><option value="viewer">Viewer</option></select></li>)}</ul><h3>Pending invites</h3><ul>{members?.pendingInvites.map((invite) => <li key={invite.email}>{invite.email} · {invite.role}</li>)}</ul><label><input checked={settings?.settings.builderCanDeploy ?? false} onChange={(event) => { void run(() => client.updateOrganizationSettings(organizationId, event.target.checked), 'Deploy policy updated.'); }} type="checkbox" /> Builders can deploy</label></>}
    </section> : null}

    {section === 'github' ? <section>
      <h2>GitHub sync</h2>
      {github === undefined ? <p>No GitHub repository is connected.</p> : <><p>State: {github.state ?? 'Not synchronized'} · {github.externalRepoRef ?? 'No external repository'}</p>{canEditProject && client !== undefined ? <><label>Sync policy <select value={github.syncPolicy} onChange={(event) => { void run(() => client.updateGitHubSyncPolicy(projectId, event.target.value as 'direct_push' | 'pull_request'), 'Sync policy updated.'); }}><option value="direct_push">Direct push</option><option value="pull_request">Pull request</option></select></label><button onClick={() => { void run(() => client.syncGitHubNow(projectId), 'GitHub sync completed.'); }} type="button">Sync now</button>{isOwner ? <GitHubExport client={client} projectId={projectId} onSaved={() => reload()} /> : null}</> : <p>Viewer access is read-only.</p>}</>}
    </section> : null}
  </main>;
}

function SecretForm({ client, environments, onSaved, projectId }: { readonly client: Client; readonly environments: ProjectData['environments']; readonly onSaved: () => Promise<void>; readonly projectId: string }): ReactElement {
  const [name, setName] = useState(''); const [value, setValue] = useState(''); const [environmentId, setEnvironmentId] = useState('');
  return <form onSubmit={(event) => { event.preventDefault(); void client.createProjectSecret(projectId, { name, value, ...(environmentId === '' ? {} : { environmentId }) }).then(() => { setValue(''); return onSaved(); }); }}><label>Name <input onChange={(event) => { setName(event.target.value); }} required value={name} /></label><label>Value <input aria-label="Secret value" onChange={(event) => { setValue(event.target.value); }} required type="password" value={value} /></label><label>Environment <select onChange={(event) => { setEnvironmentId(event.target.value); }} value={environmentId}><option value="">All environments</option>{environments.map((environment) => <option key={environment.id} value={environment.id}>{environment.name}</option>)}</select></label><button type="submit">Add secret</button></form>;
}

function RotateSecret({ client, onSaved, projectId, secretId }: { readonly client: Client; readonly onSaved: () => Promise<void>; readonly projectId: string; readonly secretId: string }): ReactElement {
  const [value, setValue] = useState(''); return <form onSubmit={(event) => { event.preventDefault(); void client.rotateProjectSecret(projectId, secretId, value).then(() => { setValue(''); return onSaved(); }); }} style={{ display: 'inline' }}><input aria-label={`New value for ${secretId}`} onChange={(event) => { setValue(event.target.value); }} placeholder="New value" required type="password" value={value} /><button type="submit">Rotate</button></form>;
}

function InviteForm({ client, onSaved, organizationId }: { readonly client: Client; readonly onSaved: () => Promise<void>; readonly organizationId: string }): ReactElement {
  const [email, setEmail] = useState(''); const [role, setRole] = useState<'owner' | 'builder' | 'viewer'>('builder'); return <form onSubmit={(event) => { event.preventDefault(); void client.inviteOrganizationMember(organizationId, { email, role }).then(() => { setEmail(''); return onSaved(); }); }}><input aria-label="Invite email" onChange={(event) => { setEmail(event.target.value); }} required type="email" value={email} /><select aria-label="Invite role" onChange={(event) => { setRole(event.target.value as typeof role); }} value={role}><option value="owner">Owner</option><option value="builder">Builder</option><option value="viewer">Viewer</option></select><button type="submit">Invite member</button></form>;
}

function IntegrationConnect({ client, onSaved, projectId, provider }: { readonly client: Client | undefined; readonly onSaved: () => Promise<void>; readonly projectId: string; readonly provider: (typeof providers)[number] }): ReactElement {
  const [credential, setCredential] = useState(''); const [account, setAccount] = useState(''); const [extra, setExtra] = useState('');
  if (provider === 'github') return <button onClick={() => { if (client !== undefined) void client.authorizeGitHubInstall().then((response) => { globalThis.location.assign(response.url); }); }} type="button">Connect GitHub</button>;
  return <form onSubmit={(event) => { event.preventDefault(); if (client === undefined) return; const request = provider === 'supabase' ? client.connectSupabase(projectId, credential, account) : provider === 'neon' ? client.connectNeon(projectId, credential, account, extra) : provider === 'stripe' ? client.connectStripe(projectId, credential, account) : client.connectVercel(projectId, credential, account, extra); void request.then(onSaved); }}><input aria-label={`${provider} credential`} onChange={(event) => { setCredential(event.target.value); }} placeholder="Credential" required type="password" value={credential} /><input aria-label={`${provider} account`} onChange={(event) => { setAccount(event.target.value); }} placeholder={provider === 'supabase' ? 'Project ref' : provider === 'stripe' ? 'Account ID' : 'Project ID'} required value={account} />{provider === 'neon' || provider === 'vercel' ? <input aria-label={`${provider} name`} onChange={(event) => { setExtra(event.target.value); }} placeholder={provider === 'neon' ? 'Database name' : 'Project name'} required value={extra} /> : null}<button type="submit">Connect {provider}</button></form>;
}

function GitHubExport({ client, onSaved, projectId }: { readonly client: Client; readonly onSaved: () => Promise<void>; readonly projectId: string }): ReactElement {
  const [installationId, setInstallationId] = useState(''); const [repositoryName, setRepositoryName] = useState(''); return <form onSubmit={(event) => { event.preventDefault(); void client.exportToGitHub(projectId, { installationId, repositoryName, private: true, syncPolicy: 'pull_request' }).then(onSaved); }}><input aria-label="GitHub installation ID" onChange={(event) => { setInstallationId(event.target.value); }} required value={installationId} /><input aria-label="GitHub repository name" onChange={(event) => { setRepositoryName(event.target.value); }} required value={repositoryName} /><button type="submit">Export to GitHub</button></form>;
}

function Danger({ client, onStatus, projectId, projectName }: { readonly client: Client | undefined; readonly onStatus: (value: string) => void; readonly projectId: string; readonly projectName: string }): ReactElement {
  const [confirmation, setConfirmation] = useState(''); return <section><h2>Danger zone</h2><label>Type {projectName} to delete <input onChange={(event) => { setConfirmation(event.target.value); }} value={confirmation} /></label><button disabled={confirmation !== projectName || client === undefined} onClick={() => { if (client !== undefined) void client.deleteProject(projectId).then((response) => { onStatus(`Deletion queued: ${response.deletion.status}. Progress will appear on the project timeline.`); }); }} type="button">Delete project</button></section>;
}
