import type { ReactElement } from 'react';

import type { MissionControlData } from '../../lib/api';

export function Risks({ data }: { readonly data: MissionControlData }): ReactElement {
  return <ul aria-label="Verifier risks">{data.risks.map((risk) => <li data-severity={risk.severity} key={risk.id}><strong>{risk.severity}</strong>: {risk.summary}</li>)}</ul>;
}
