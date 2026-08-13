'use client';

import { useState, type ReactElement, type SyntheticEvent } from 'react';

import type { ProjectSettingsController } from './useProjectSettings';
import styles from './settings.module.css';

export function MembersSettings({
  controller,
}: { readonly controller: ProjectSettingsController }): ReactElement {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'owner' | 'builder' | 'viewer'>('builder');
  if (!controller.isOwner || controller.client === undefined || controller.organizationId === undefined) {
    return <section className={styles.section}><h2>Members</h2><p className={styles.readOnly}>Only Owners can manage members.</p></section>;
  }
  const client = controller.client;
  const organizationId = controller.organizationId;
  const invite = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const saved = await controller.run(
      () => client.inviteOrganizationMember(organizationId, { email, role }),
      'Member invited.',
    );
    if (saved) setEmail('');
  };

  return (
    <section className={styles.section}>
      <div><h2>Members</h2><p>Control project access through organization roles.</p></div>
      <form className={styles.inlineForm} onSubmit={(event) => {
        void invite(event);
      }}>
        <input aria-label="Invite email" onChange={(event) => {
          setEmail(event.target.value);
        }} required type="email" value={email} />
        <select aria-label="Invite role" onChange={(event) => {
          setRole(event.target.value as typeof role);
        }} value={role}>
          <option value="owner">Owner</option><option value="builder">Builder</option><option value="viewer">Viewer</option>
        </select>
        <button className="zapp-button zapp-button--primary" type="submit">Invite member</button>
      </form>
      <ul className={styles.itemList}>
        {controller.members?.members.map((member) => (
          <li key={member.user.id}>
            <div><strong>{member.user.displayName}</strong><small>{member.user.email}</small></div>
            <select
              aria-label={`Role for ${member.user.email}`}
              onChange={(event) => {
                void controller.run(
                  () => client.updateOrganizationMember(
                    organizationId,
                    member.user.id,
                    event.target.value as 'owner' | 'builder' | 'viewer',
                  ),
                  'Member role updated.',
                );
              }}
              value={member.role}
            >
              <option value="owner">Owner</option><option value="builder">Builder</option><option value="viewer">Viewer</option>
            </select>
          </li>
        ))}
      </ul>
      <h3>Pending invites</h3>
      <ul>{controller.members?.pendingInvites.map((item) => <li key={item.email}>{item.email} · {item.role}</li>)}</ul>
      <label className={styles.checkboxLabel}>
        <input
          checked={controller.settings?.settings.builderCanDeploy ?? false}
          onChange={(event) => {
            void controller.run(
              () => client.updateOrganizationSettings(organizationId, event.target.checked),
              'Deploy policy updated.',
            );
          }}
          type="checkbox"
        />
        Builders can deploy
      </label>
    </section>
  );
}
