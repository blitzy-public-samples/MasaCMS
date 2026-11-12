// SYNTHETIC: opt2-modules - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Root layout of the OPT-2 synthetic screens; the page's bootstrap script sets the `<html>` and `<body>` attributes. */
export default function Opt2RootLayout({ children }: { children: ReactNode }) {
  return (
    <html suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
