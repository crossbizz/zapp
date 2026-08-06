import type { Metadata } from 'next';
import type { ReactElement, ReactNode } from 'react';
import '@zapp/ui/tokens.css';

export const metadata: Metadata = { title: 'zapp.build' };

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>): ReactElement {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
