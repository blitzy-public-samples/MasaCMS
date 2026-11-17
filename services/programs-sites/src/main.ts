// Tracing must start before Fastify, pg and undici load, so the service-kit and the app are imported dynamically.
import { shutdownTracing, startTracing } from '@opt2/platform/tracing';

const SERVICE = 'programs-sites';
const VERSION = '1.0.0';

let app: Awaited<ReturnType<typeof import('./app.js').buildApp>> | undefined;
try {
  await startTracing({ serviceName: SERVICE, version: VERSION });
  const { loadEnv } = await import('@opt2/platform/service-kit');
  const { buildApp, programsSitesEnvSchema } = await import('./app.js');
  const env = loadEnv(programsSitesEnvSchema);
  app = await buildApp({ env });
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
} catch (err) {
  process.exitCode = 1;
  // The logging barrel loads Fastify, so it is imported only once tracing has started or failed.
  const { logStartupFailure, serializeError } = await import('@opt2/platform/logging');
  const options = { service: SERVICE, version: VERSION };
  if (app === undefined) {
    try {
      await logStartupFailure(err, options);
    } finally {
      // No kit shutdown exists before the app is built, so tracing stops here and exports the spans start-up buffered.
      await shutdownTracing().catch((error: unknown) => logStartupFailure(error, { ...options, message: 'shutdown failed' }));
    }
  } else {
    const built = app;
    built.log.error({ error: serializeError(err) }, 'start-up failed');
    // A built app holds its pool, publisher and task port open, so the process would never exit without the kit's shutdown.
    await built.opt2.shutdown().catch((error: unknown) => built.log.error({ error: serializeError(error) }, 'shutdown failed'));
  }
}
