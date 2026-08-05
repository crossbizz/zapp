'use client';

import { useState, type ReactElement } from 'react';

import { createControlPlaneClient } from '../lib/api';

export function DeviceConsent({ userCode }: { readonly userCode: string | null }): ReactElement {
  const [result, setResult] = useState<string>();

  const decide = async (decision: 'approve' | 'deny'): Promise<void> => {
    if (userCode === null) return;
    try {
      const client = createControlPlaneClient();
      if (decision === 'approve') await client.approveDevice(userCode);
      else await client.denyDevice(userCode);
      setResult(decision === 'approve' ? 'Device sign-in approved.' : 'Device sign-in denied.');
    } catch {
      setResult('The device sign-in request could not be completed.');
    }
  };

  if (userCode === null) return <main>Device sign-in code is required.</main>;

  return (
    <main>
      <h1>Approve device sign-in</h1>
      <p>A device is asking for access with code {userCode}</p>
      <button type="button" onClick={() => void decide('approve')}>Approve</button>
      <button type="button" onClick={() => void decide('deny')}>Deny</button>
      {result === undefined ? null : <p role="status">{result}</p>}
    </main>
  );
}
