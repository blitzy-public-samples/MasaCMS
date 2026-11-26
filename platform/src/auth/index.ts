// Public surface of @opt2/platform/auth: roles, claims, user-token and invocation credentials, header stripping, transports, deny-by-default hooks, the route matrix and the abort bound for signal-less credential work.
export * from './roles.js';
export * from './claims.js';
export * from './user-token.js';
export * from './invocation.js';
export * from './strip.js';
export * from './transports.js';
export * from './hooks.js';
export * from './matrix.js';
export { untilAborted } from './deadline.js';
// The JOSE library pinned in platform/package.json: JWT signing, decoding and verification, and key export.
export { SignJWT, jwtVerify, decodeJwt, decodeProtectedHeader, createLocalJWKSet, exportJWK, exportPKCS8 } from 'jose';
export type { JWK, JSONWebKeySet } from 'jose';
