// Next.js start-up hook: boots the web process before it serves a request.

/** Runs the web boot in the Node.js runtime; Next awaits it before any route handler runs. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { bootWeb } = await import('./src/lib/boot');
  await bootWeb();
}
