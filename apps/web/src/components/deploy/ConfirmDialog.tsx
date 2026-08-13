import type { ReactElement } from 'react';
import type { DeploymentPreviewData } from '../../lib/api';

export function ConfirmDialog({ preview, disposition, onDisposition, onConfirm, onBack }: {
  readonly preview: DeploymentPreviewData;
  readonly disposition: 'preserve' | 'transfer' | 'reset' | undefined;
  readonly onDisposition: (value: 'preserve' | 'transfer' | 'reset') => void;
  readonly onConfirm: () => void;
  readonly onBack: () => void;
}): ReactElement {
  return <section aria-label="Confirm deployment" role="dialog"><h2>{preview.title}</h2><ul><li>Production data: {preview.effects.productionData}</li><li>Secrets: {preview.effects.secrets}</li><li>URL: {preview.effects.url}</li><li>Users: {preview.effects.activeUsers}</li></ul>{preview.requiresExplicitDataDisposition ? <fieldset><legend>Production data disposition</legend>{(['preserve', 'transfer', 'reset'] as const).map((value) => <label key={value}><input checked={disposition === value} name="data-disposition" onChange={() => { onDisposition(value); }} type="radio" />{value}</label>)}</fieldset> : null}<button onClick={onBack} type="button">Back</button><button disabled={preview.requiresExplicitDataDisposition && disposition === undefined} onClick={onConfirm} type="button">Confirm deployment</button></section>;
}
