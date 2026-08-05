'use client';

import { useEffect, useState, type ReactElement } from 'react';

import { DeviceConsent } from '../../components/device-consent';

export default function DevicePage(): ReactElement {
  const [userCode, setUserCode] = useState<string | null>(null);

  useEffect(() => {
    setUserCode(new URLSearchParams(window.location.search).get('userCode'));
  }, []);

  return <DeviceConsent userCode={userCode} />;
}
