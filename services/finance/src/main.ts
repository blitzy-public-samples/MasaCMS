// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
// Tracing must start before Fastify, pg and undici load, so the service-kit and the app are imported dynamically.
import { startTracing } from '@opt2/platform/tracing';

await startTracing({ serviceName: 'finance', version: '1.0.0' });

const { loadEnv, baseEnvSchema } = await import('@opt2/platform/service-kit');
const { buildApp } = await import('./app.js');

const env = loadEnv(baseEnvSchema);
const app = await buildApp({ env });
await app.listen({ port: env.PORT, host: '0.0.0.0' });
