import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { renderAdminPage } from '@/lib/handlers';
import { toString } from '@/lib/html';
import { attributeBootstrapScript } from '@/shell/document';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface AdminPageProps {
  params: Promise<{ circuit: string; action: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Page-mode adapter for carried legacy admin actions. */
export default async function AdminPage({ params, searchParams }: AdminPageProps) {
  const result = await renderAdminPage(await params, await searchParams, await headers());
  // A page cannot set its status: the gateway turns redirect()'s 307 into 302 and a failed render's 500 into 503.
  switch (result.kind) {
    case 'document': {
      const doc = result.document;
      const markup = toString(attributeBootstrapScript(doc)) + toString(doc.head) + toString(doc.body);
      return <div style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: markup }} />;
    }
    case 'redirect':
      return redirect(result.location);
    case 'not-found':
    case 'refused':
      return notFound();
    case 'unavailable':
      throw new Error('An admin page dependency is unavailable');
  }
}
