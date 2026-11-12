import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

/** Root layout of the admin page tree; the page's bootstrap script sets the legacy `<html>` and `<body>` attributes. */
export default function AdminRootLayout({ children }: { children: ReactNode }) {
  return (
    <html suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
