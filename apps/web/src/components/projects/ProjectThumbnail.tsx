import Image from 'next/image';
import type { ReactElement } from 'react';

import styles from './projects.module.css';

export interface ProjectThumbnailProps {
  readonly alt: string | undefined;
  readonly name: string;
  readonly url: string | undefined;
}

export function ProjectThumbnail({ alt, name, url }: ProjectThumbnailProps): ReactElement {
  if (url === undefined || alt === undefined) {
    return (
      <div
        aria-label={`Preview unavailable for ${name}`}
        className={`${styles.projectThumbnail ?? ''} ${styles.projectThumbnailFallback ?? ''}`}
        role="img"
      >
        <span aria-hidden="true">{name.slice(0, 2).toUpperCase()}</span>
      </div>
    );
  }

  return (
    <div className={styles.projectThumbnail}>
      <Image alt={alt} fill sizes="(max-width: 640px) 100vw, 36rem" src={url} unoptimized />
    </div>
  );
}
