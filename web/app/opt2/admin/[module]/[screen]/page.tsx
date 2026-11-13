// SYNTHETIC: opt2-modules - no Masa equivalent; legacy oracle in legacy-fixtures/
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { renderOpt2Page } from '@/lib/handlers';
import { toString } from '@/lib/html';
import { attributeBootstrapScript } from '@/shell/document';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface Opt2PageProps {
  params: Promise<{ module: string; screen: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Page adapter for OPT-2 synthetic module screens. */
export default async function Opt2Page({ params, searchParams }: Opt2PageProps) {
  const result = await renderOpt2Page(await params, await searchParams, await headers());
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
