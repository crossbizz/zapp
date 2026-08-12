'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactElement } from 'react';

import { createControlPlaneClient, type TemplateListData } from '../../lib/api';
import styles from './templates.module.css';

export function TemplateGallery(): ReactElement {
  const [data, setData] = useState<TemplateListData>();
  const [failed, setFailed] = useState(false);
  useEffect(() => { const controller = new AbortController(); void createControlPlaneClient().listTemplates(controller.signal).then(setData).catch(() => { if (!controller.signal.aborted) setFailed(true); }); return () => { controller.abort(); }; }, []);
  return <main className={styles.page}><header className={styles.header}><div><p>Start faster</p><h1>Templates</h1></div><Link href="/">Back home</Link></header>
    {failed ? <p role="alert">Templates could not be loaded.</p> : null}
    {data === undefined && !failed ? <p role="status">Loading templates…</p> : <section aria-label="Template gallery" className={styles.grid}>{data?.templates.map((template) => <Link className={styles.card} href={`/templates/${template.slug}`} key={template.slug}><h2>{template.name}</h2><p>{template.description}</p><ul className={styles.chips}>{template.stack.map((item) => <li key={item}>{item}</li>)}</ul></Link>)}</section>}
  </main>;
}
