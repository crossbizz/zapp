import type { ReactElement, ReactNode } from 'react';

export interface PageFrameProps {
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly description?: string;
  readonly eyebrow?: string;
  readonly title: string;
}

export function PageFrame({
  actions,
  children,
  description,
  eyebrow,
  title,
}: PageFrameProps): ReactElement {
  return (
    <div className="zapp-page-frame">
      <header className="zapp-page-frame__header">
        <div className="zapp-page-frame__heading">
          {eyebrow === undefined ? null : (
            <p className="zapp-page-frame__eyebrow">{eyebrow}</p>
          )}
          <h1>{title}</h1>
          {description === undefined ? null : (
            <p className="zapp-page-frame__description">{description}</p>
          )}
        </div>
        {actions === undefined ? null : (
          <div className="zapp-page-frame__actions">{actions}</div>
        )}
      </header>
      <div className="zapp-page-frame__content">{children}</div>
      <style jsx global>{`
        .zapp-page-frame {
          width: min(72rem, 100%);
          min-height: 100%;
          margin: 0 auto;
          padding: 2.25rem clamp(1rem, 3vw, 3rem) 4rem;
          color: var(--zapp-text-primary);
        }

        .zapp-page-frame__header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 2rem;
          margin-bottom: 1.75rem;
        }

        .zapp-page-frame__heading {
          max-width: 48rem;
        }

        .zapp-page-frame__eyebrow {
          margin: 0 0 0.4rem;
          color: var(--zapp-text-muted);
          font-size: var(--zapp-text-12);
          font-weight: 720;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }

        .zapp-page-frame h1 {
          margin: 0;
          font-size: clamp(2rem, 4vw, 3rem);
          line-height: 1.04;
          letter-spacing: -0.045em;
        }

        .zapp-page-frame__description {
          max-width: 44rem;
          margin: 0.75rem 0 0;
          color: var(--zapp-text-secondary);
          font-size: var(--zapp-text-16);
          line-height: 1.6;
        }

        .zapp-page-frame__actions,
        .zapp-page-actions,
        .zapp-org-nav {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 0.5rem;
        }

        .zapp-page-frame__actions a,
        .zapp-page-actions a,
        .zapp-org-nav a {
          border: 1px solid var(--zapp-border);
          border-radius: var(--zapp-radius-pill);
          padding: 0.55rem 0.85rem;
          color: var(--zapp-text-secondary);
          background: var(--zapp-surface-raised);
          font-size: var(--zapp-text-14);
          font-weight: 650;
          text-decoration: none;
        }

        .zapp-page-frame__actions a:hover,
        .zapp-page-frame__actions a:focus-visible,
        .zapp-page-actions a:hover,
        .zapp-page-actions a:focus-visible,
        .zapp-org-nav a:hover,
        .zapp-org-nav a:focus-visible,
        .zapp-org-nav a[aria-current='page'] {
          color: var(--zapp-text-primary);
          background: var(--zapp-surface-subtle);
        }

        .zapp-page-frame__actions a:focus-visible,
        .zapp-page-actions a:focus-visible,
        .zapp-org-nav a:focus-visible,
        .zapp-page-frame button:focus-visible,
        .zapp-page-frame input:focus-visible,
        .zapp-page-frame select:focus-visible {
          outline: 3px solid var(--zapp-focus);
          outline-offset: 2px;
        }

        .zapp-page-frame__content {
          display: grid;
          gap: 1rem;
        }

        .zapp-org-nav {
          margin-bottom: 0.5rem;
        }

        .zapp-page-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(min(17rem, 100%), 1fr));
          gap: 1rem;
        }

        .zapp-page-card {
          overflow-x: auto;
          border: 1px solid var(--zapp-border);
          border-radius: var(--zapp-radius-panel);
          padding: clamp(1rem, 2vw, 1.5rem);
          background: var(--zapp-surface-raised);
          box-shadow: 0 1px 2px rgb(24 24 27 / 0.03);
        }

        .zapp-page-card h2,
        .zapp-page-card h3,
        .zapp-page-card p:first-child {
          margin-top: 0;
        }

        .zapp-page-card--emphasis {
          background:
            linear-gradient(135deg, rgb(99 102 241 / 0.08), rgb(236 72 153 / 0.05)),
            var(--zapp-surface-raised);
        }

        .zapp-page-metric {
          display: block;
          margin: 0.4rem 0;
          font-size: clamp(2rem, 5vw, 3.5rem);
          letter-spacing: -0.045em;
        }

        .zapp-page-form-row,
        .zapp-page-button-row {
          display: flex;
          flex-wrap: wrap;
          align-items: flex-end;
          gap: 0.75rem;
        }

        .zapp-page-field {
          display: grid;
          gap: 0.4rem;
          color: var(--zapp-text-secondary);
          font-size: var(--zapp-text-14);
          font-weight: 650;
        }

        .zapp-page-field input,
        .zapp-page-field select,
        .zapp-page-frame input,
        .zapp-page-frame select {
          min-height: 2.6rem;
          border: 1px solid var(--zapp-border);
          border-radius: 0.625rem;
          padding: 0.55rem 0.7rem;
          color: var(--zapp-text-primary);
          background: var(--zapp-surface-raised);
          font: inherit;
        }

        .zapp-page-frame button {
          min-height: 2.5rem;
          border: 1px solid var(--zapp-border);
          border-radius: var(--zapp-radius-pill);
          padding: 0.55rem 0.9rem;
          color: var(--zapp-text-primary);
          background: var(--zapp-surface-raised);
          font: inherit;
          font-size: var(--zapp-text-14);
          font-weight: 680;
          cursor: pointer;
        }

        .zapp-page-frame button:hover:not(:disabled) {
          background: var(--zapp-surface-subtle);
        }

        .zapp-page-frame button:disabled {
          cursor: not-allowed;
          opacity: 0.5;
        }

        .zapp-page-button--primary {
          border-color: transparent !important;
          color: var(--zapp-text-inverse) !important;
          background: var(--zapp-surface-inverse) !important;
        }

        .zapp-page-table {
          width: 100%;
          border-collapse: collapse;
          font-size: var(--zapp-text-14);
        }

        .zapp-page-table th,
        .zapp-page-table td {
          border-bottom: 1px solid var(--zapp-border);
          padding: 0.75rem 0.6rem;
          text-align: left;
          vertical-align: top;
        }

        .zapp-page-table th {
          color: var(--zapp-text-secondary);
          font-weight: 700;
        }

        .zapp-page-list {
          display: grid;
          gap: 0.75rem;
          margin: 0;
          padding: 0;
          list-style: none;
        }

        .zapp-page-list > li,
        .zapp-page-list > article {
          border: 1px solid var(--zapp-border);
          border-radius: 0.75rem;
          padding: 1rem;
          background: var(--zapp-surface-raised);
        }

        .zapp-page-status {
          min-height: 1.25rem;
          margin: 0;
          color: var(--zapp-text-secondary);
          font-size: var(--zapp-text-14);
        }

        .zapp-page-alert {
          border: 1px solid color-mix(in srgb, var(--zapp-status-danger) 35%, var(--zapp-border));
          border-radius: 0.75rem;
          padding: 0.8rem 1rem;
          color: var(--zapp-status-danger);
          background: color-mix(in srgb, var(--zapp-status-danger) 5%, var(--zapp-surface-raised));
        }

        @media (max-width: 44rem) {
          .zapp-page-frame {
            padding-top: 1.5rem;
          }

          .zapp-page-frame__header {
            display: grid;
            gap: 1rem;
          }

          .zapp-page-frame__actions {
            order: -1;
          }
        }
      `}</style>
    </div>
  );
}
