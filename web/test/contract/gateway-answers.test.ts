// The gateway's own answers web reads, as the test fixtures stand in for them, against the gateway contract.
import { readFileSync } from 'node:fs';
import { assertResponseMatchesOpenApi } from '@opt2/platform/testing';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { LEGACY_VERSION_MENU_PATH } from '@/lib/gateway-client';
import { LEGACY_VERSION_MENU } from '../fixtures/gateway/version-menu';

const GATEWAY_CONTRACT = parse(readFileSync(new URL('../../../gateway/contracts/openapi.yaml', import.meta.url), 'utf8')) as object;

describe('getLegacyVersionMenu against the gateway contract', () => {
  it.each([
    { name: "the oracle's facts", body: LEGACY_VERSION_MENU },
    { name: 'a Java version without OS keys', body: { ...LEGACY_VERSION_MENU, javaVersion: '11.0.2', osName: null, osVersion: null } },
  ])('answers $name as the gateway declares', ({ body }) => {
    expect(() =>
      assertResponseMatchesOpenApi(GATEWAY_CONTRACT, {
        method: 'GET',
        path: LEGACY_VERSION_MENU_PATH,
        status: 200,
        contentType: 'application/json;charset=utf-8',
        body: JSON.stringify(body),
      }),
    ).not.toThrow();
  });

  it('refuses an answer without a menu value', () => {
    const body = Object.fromEntries(Object.entries(LEGACY_VERSION_MENU).filter(([name]) => name !== 'dbProductName'));
    expect(() =>
      assertResponseMatchesOpenApi(GATEWAY_CONTRACT, {
        method: 'GET',
        path: LEGACY_VERSION_MENU_PATH,
        status: 200,
        contentType: 'application/json;charset=utf-8',
        body: JSON.stringify(body),
      }),
    ).toThrow();
  });
});
