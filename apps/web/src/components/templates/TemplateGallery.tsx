'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactElement } from 'react';

import { createControlPlaneClient, type TemplateListData } from '../../lib/api';
import { PageFrame } from '../shell/PageFrame';
import styles from './templates.module.css';

export function TemplateGallery(): ReactElement {
  const [data, setData] = useState<TemplateListData>();
  const [failed, setFailed] = useState(false);
  useEffect(() => { const controller = new AbortController(); void createControlPlaneClient().listTemplates(controller.signal).then(setData).catch(() => { if (!controller.signal.aborted) setFailed(true); }); return () => { controller.abort(); }; }, []);
  return (
    <main className={styles.page}>
      <PageFrame
        actions={<Link href="/">Back home</Link>}
        description="Start with a proven foundation, then remix it into your own product."
        eyebrow="Start faster"
        title="Templates"
      >
        {failed ? <p className="zapp-page-alert" role="alert">Templates could not be loaded.</p> : null}
        {data === undefined && !failed ? (
          <p className="zapp-page-status" role="status">Loading templates…</p>
        ) : (
          <section aria-label="Template gallery" className={styles.grid}>
            {data?.templates.length === 0 ? (
              <div className="zapp-page-card"><p>No templates are available yet.</p></div>
            ) : null}
            {data?.templates.map((template) => (
              <Link className={styles.card} href={`/templates/${template.slug}`} key={template.slug}>
                <span className={styles.cardPreview} aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
                <h2>{template.name}</h2>
                <p>{template.description}</p>
                <ul className={styles.chips}>
                  {template.stack.map((item) => <li key={item}>{item}</li>)}
                </ul>
              </Link>
            ))}
          </section>
        )}
      </PageFrame>
    </main>
  );
}
