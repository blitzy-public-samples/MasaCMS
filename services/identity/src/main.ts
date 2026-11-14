// Tracing must start before Fastify, pg and undici load, so the service-kit and the app are imported dynamically.
import { startTracing } from '@opt2/platform/tracing';

await startTracing({ serviceName: 'identity', version: '1.0.0' });

const { loadEnv } = await import('@opt2/platform/service-kit');
const { buildApp, identityEnvSchema } = await import('./app.js');

const env = loadEnv(identityEnvSchema);
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
try {
  app = await buildApp({ env });
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
} catch (err) {
  process.exitCode = 1;
  if (app === undefined) {
    console.error(err);
  } else {
    app.log.error(err, 'start-up failed');
    // A built app holds its pool and task port open, so the process would never exit without the kit's shutdown.
    await app.opt2.shutdown();
  }
}
