import * as cloudSqlConnector from '@google-cloud/cloud-sql-connector';
import * as pubsub from '@google-cloud/pubsub';
import * as jose from 'jose';
import pgDriver from 'pg';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as auth from '../../src/auth/index.js';
import * as events from '../../src/events/index.js';
import * as tenancy from '../../src/tenancy/index.js';

/** Library bindings each subpath re-exports: subpath, barrel, exported name, the library's own binding and its runtime type. */
const REEXPORTS: readonly (readonly [string, Record<string, unknown>, string, unknown, 'function' | 'object'])[] = [
  ['tenancy', tenancy, 'pg', pgDriver, 'object'],
  ['tenancy', tenancy, 'Connector', cloudSqlConnector.Connector, 'function'],
  ['tenancy', tenancy, 'AuthTypes', cloudSqlConnector.AuthTypes, 'object'],
  ['tenancy', tenancy, 'IpAddressTypes', cloudSqlConnector.IpAddressTypes, 'object'],
  ['events', events, 'PubSub', pubsub.PubSub, 'function'],
  ['events', events, 'v1', pubsub.v1, 'object'],
  ['auth', auth, 'SignJWT', jose.SignJWT, 'function'],
  ['auth', auth, 'jwtVerify', jose.jwtVerify, 'function'],
  ['auth', auth, 'decodeJwt', jose.decodeJwt, 'function'],
  ['auth', auth, 'decodeProtectedHeader', jose.decodeProtectedHeader, 'function'],
  ['auth', auth, 'createLocalJWKSet', jose.createLocalJWKSet, 'function'],
  ['auth', auth, 'exportJWK', jose.exportJWK, 'function'],
  ['auth', auth, 'exportPKCS8', jose.exportPKCS8, 'function'],
];

describe('shared library re-exports', () => {
  it.each(REEXPORTS)('@opt2/platform/%s exposes %s as the pinned library binding', (_subpath, barrel, name, binding, kind) => {
    expect(barrel[name]).toBe(binding);
    expect(typeof barrel[name]).toBe(kind);
  });

  it('exposes the pg driver classes, the connector enums and the generated Pub/Sub clients', () => {
    expect(typeof tenancy.pg.Client).toBe('function');
    expect(typeof tenancy.pg.Pool).toBe('function');
    expect(typeof tenancy.Connector.prototype.getOptions).toBe('function');
    expect(tenancy.AuthTypes.IAM).toBe('IAM');
    expect(tenancy.IpAddressTypes.PRIVATE).toBe('PRIVATE');
    expect(typeof events.v1.SubscriberClient).toBe('function');
    expect(typeof events.v1.PublisherClient).toBe('function');
  });

  it('signs with the auth re-exports a token their decoders and verifier read back', async () => {
    const { privateKey, publicKey } = await jose.generateKeyPair('RS256', { extractable: true });
    const jwk: auth.JWK = { ...(await auth.exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
    const jwks: auth.JSONWebKeySet = { keys: [jwk] };
    const token = await new auth.SignJWT({ roles: ['admin'] })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setSubject('user-1')
      .sign(privateKey);
    expect(auth.decodeProtectedHeader(token)).toEqual({ alg: 'RS256', kid: 'k1' });
    expect(auth.decodeJwt(token)).toEqual({ roles: ['admin'], sub: 'user-1' });
    const { payload } = await auth.jwtVerify(token, auth.createLocalJWKSet(jwks));
    expect(payload.sub).toBe('user-1');
    expect(await auth.exportPKCS8(privateKey)).toMatch(/^-----BEGIN PRIVATE KEY-----/);
  });

  it('re-exports the library types unchanged', () => {
    expectTypeOf<tenancy.ClientConfig>().toEqualTypeOf<pgDriver.ClientConfig>();
    expectTypeOf<tenancy.pg.Client>().toEqualTypeOf<pgDriver.Client>();
    expectTypeOf<events.Message>().toEqualTypeOf<pubsub.Message>();
    expectTypeOf<events.protos.google.pubsub.v1.IPubsubMessage>().toEqualTypeOf<pubsub.protos.google.pubsub.v1.IPubsubMessage>();
    expectTypeOf<auth.JWK>().toEqualTypeOf<jose.JWK>();
    expectTypeOf<auth.JSONWebKeySet>().toEqualTypeOf<jose.JSONWebKeySet>();
  });
});
