/** Public surface of `@opt2/platform/events`; the `opt2-events` CLI is not re-exported, so importing this never runs it. */
export * from './naming.js';
export * from './envelope.js';
export * from './validation.js';
export * from './publisher.js';
export * from './dlq.js';
export * from './ddl.js';
export * from './consumer.js';
export * from './push.js';
// The Pub/Sub client library pinned in platform/package.json: the client, the generated v1 clients and their types.
export { PubSub, v1 } from '@google-cloud/pubsub';
export type { Message, protos } from '@google-cloud/pubsub';
