/** Public surface of `@opt2/platform/service-kit`: the kit's own exports, plus the Fastify types and zod they are used with. */
export { systemClock, fixedClock, isClock, type Clock } from './clock.js';
export {
  baseEnvSchema,
  loadEnv,
  envModeIssues,
  EnvValidationError,
  publisherEmulatorHost,
  optionalEnvString,
  requiredEnvString,
  envUrl,
  envPort,
  type BaseEnv,
  type EnvSchema,
  type LoadedEnv,
} from './env.js';
export {
  requestContext,
  currentRequestContext,
  requireRequestContext,
  runWithRequestContext,
  newRequestContext,
  requestIdFrom,
  recordWritePosition,
  REQUEST_ID_HEADER,
  NoRequestContextError,
  type RequestContextStore,
} from './context.js';
export {
  createServiceClient,
  decodeServiceBody,
  SERVICE_CALL_TIMEOUT_MS,
  ServiceUnavailableError,
  UnknownServiceError,
  type ServiceClient,
  type ServiceClientOptions,
  type ServiceRequest,
  type ServiceResponse,
} from './client.js';
export { createSignalBoundFetch } from './fetch.js';
export {
  createService,
  defaultSurfaceOf,
  isUnstorableTextError,
  legacyParamsOf,
  multipartFilesOf,
  recordOutcomeReason,
  sendLegacyResponse,
  LEGACY_POST_LIMIT_BYTES,
  type CreateServiceOptions,
  type LegacyParamsOptions,
  type Opt2Runtime,
  type Opt2RequestScope,
  type LegacySurface,
} from './create-service.js';
export {
  csrfPreHandler,
  csrfTokenFrom,
  CSRF_CONSUME_PATH,
  IDENTITY_SERVICE,
  type CsrfConsumeRequest,
  type CsrfConsumeResponse,
  type CsrfPreHandlerOptions,
} from './csrf-hook.js';
export type {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
  FastifyPluginAsync,
  RouteOptions,
  RouteShorthandOptions,
} from 'fastify';
export { z } from 'zod';
