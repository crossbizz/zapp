'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactElement } from 'react';

import { createControlPlaneClient, type TemplateDetailData } from '../../lib/api';
import { rememberFirstPrompt } from '../../lib/prompt-handoff';
import { activeMemberships, organizationStorageKey } from '../../lib/session';
import styles from './templates.module.css';

export function TemplateDetail({ slug }: { readonly slug: string }): ReactElement {
  const router = useRouter();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [data, setData] = useState<TemplateDetailData>();
  const [width, setWidth] = useState('100%');
  const [status, setStatus] = useState('');
  useEffect(() => { const controller = new AbortController(); void createControlPlaneClient().getTemplate(slug, controller.signal).then(setData).catch(() => { if (!controller.signal.aborted) setStatus('Template could not be loaded.'); }); return () => { controller.abort(); }; }, [slug]);
  const remix = async (): Promise<void> => {
    if (data === undefined) return;
    setStatus('Creating your Remix…');
    try {
      const profile = await createControlPlaneClient().getMe();
      const memberships = activeMemberships(profile.memberships);
      const remembered = localStorage.getItem(organizationStorageKey(profile.user.id));
      const membership = memberships.find((item) => item.organization.id === remembered) ?? memberships[0];
      if (membership === undefined) throw new Error('No active organization');
      const created = await createControlPlaneClient(membership.organization.id).createProject({ name: `${data.template.name} Remix`, sourceType: 'template', templateSlug: data.template.slug });
      rememberFirstPrompt(created.project.id, `I'm starting from the ${data.template.name} template`);
      router.push(`/projects/${created.project.id}`);
    } catch { setStatus('The Remix could not be created. Retry safely.'); }
  };
  if (data === undefined) return <main className={styles.page}><p role="status">{status || 'Loading template…'}</p></main>;
  const template = data.template;
  return <main className={styles.page}><header className={styles.header}><Link href="/templates">← All templates</Link></header><div className={styles.detail}>
    <section className={styles.panel}><h1>{template.name}</h1><p>{template.description}</p><h2>Pages included</h2><ul className={styles.chips}>{template.pagesIncluded.map((page) => <li key={page}>{page}</li>)}</ul><h2>Highlights</h2><ul className={styles.chips}>{template.highlights.map((highlight) => <li key={highlight}>{highlight}</li>)}</ul><h2>Stack</h2><ul className={styles.chips}>{template.stack.map((item) => <li key={item}>{item}</li>)}</ul><button className={styles.remix} onClick={() => { void remix(); }} type="button">Remix this template</button><p aria-live="polite">{status}</p></section>
    <section aria-label="Live template preview" className={styles.preview}><div className={styles.toolbar}><div aria-label="Preview device" className={styles.devices}><button aria-pressed={width === '100%'} onClick={() => { setWidth('100%'); }} type="button">Desktop</button><button aria-pressed={width === '768px'} onClick={() => { setWidth('768px'); }} type="button">Tablet</button><button aria-pressed={width === '390px'} onClick={() => { setWidth('390px'); }} type="button">Mobile</button></div><div className={styles.tools}><button onClick={() => { const frame = frameRef.current; if (frame !== null) frame.src = template.demoUrl; }} type="button">Refresh</button><a href={template.demoUrl} rel="noreferrer" target="_blank">Open demo</a></div></div><iframe className={styles.frame} ref={frameRef} src={template.demoUrl} style={{ maxWidth: width }} title={`${template.name} live demo`} /></section>
  </div></main>;
}
