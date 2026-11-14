// Tracing must start before Fastify, pg and undici load, so the service-kit and the app are imported dynamically.
import { startTracing } from '@opt2/platform/tracing';

const SERVICE = 'people';
const VERSION = '1.0.0';

let app: Awaited<ReturnType<typeof import('./app.js').buildApp>> | undefined;
try {
  await startTracing({ serviceName: SERVICE, version: VERSION });
  const { loadEnv } = await import('@opt2/platform/service-kit');
  const { buildApp, peopleEnvSchema } = await import('./app.js');
  const env = loadEnv(peopleEnvSchema);
  app = await buildApp({ env });
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
} catch (err) {
  process.exitCode = 1;
  if (app === undefined) {
    // The logging barrel loads Fastify, so it is imported only once tracing has started or failed.
    const { logStartupFailure } = await import('@opt2/platform/logging');
    await logStartupFailure(err, { service: SERVICE, version: VERSION });
  } else {
    app.log.error(err, 'start-up failed');
    // A built app holds its pool, publisher and task port open, so the process would never exit without the kit's shutdown.
    await app.opt2.shutdown();
  }
}
