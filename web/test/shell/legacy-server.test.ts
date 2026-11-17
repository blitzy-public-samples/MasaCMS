// Unit tests for the Version menu facts read from the legacy environment record.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadLegacyServerInfo } from '@/shell/legacy-server';
import { useTestEnv } from '../helpers/env';

/** `settings.versionMenu` as `harness/src/baseline/environment.ts` records the ACF 2023 oracle. */
const ORACLE_MENU = {
  appServerProductName: 'ColdFusion Server',
  appServerVersion: '2023,0,26,331018',
  dbProductName: 'Microsoft SQL Server',
  dbProductVersion: 'Microsoft SQL Server 2022 - 16.0.4305.5',
  javaVersion: null,
  osName: 'UNIX',
  osVersion: '6.12.105+',
};

let stateDir: string;
let restoreEnv: () => void;

/** Writes `text` as `<stateDir>/baseline/environment.json`. */
function writeRecord(text: string): void {
  mkdirSync(path.join(stateDir, 'baseline'), { recursive: true });
  writeFileSync(path.join(stateDir, 'baseline', 'environment.json'), text);
}

beforeEach(() => {
  stateDir = mkdtempSync(path.join(os.tmpdir(), 'opt2-web-legacy-server-'));
  restoreEnv = useTestEnv({ OPT2_STATE_DIR: stateDir });
});

afterEach(() => {
  restoreEnv();
  rmSync(stateDir, { recursive: true, force: true });
});

describe('loadLegacyServerInfo', () => {
  it('reads the recorded Version menu values, an absent Java or OS key as empty text', async () => {
    writeRecord(JSON.stringify({ local: null, services: { probes: [] }, settings: { ping: false, versionMenu: ORACLE_MENU } }));
    expect(await loadLegacyServerInfo()).toEqual({ ...ORACLE_MENU, javaVersion: '' });
    writeRecord(JSON.stringify({ settings: { versionMenu: { ...ORACLE_MENU, javaVersion: '11.0.2', osName: null, osVersion: null } } }));
    expect(await loadLegacyServerInfo()).toEqual({ ...ORACLE_MENU, javaVersion: '11.0.2', osName: '', osVersion: '' });
  });

  it.each([
    { name: 'no record exists', record: undefined },
    { name: 'only the local phase is recorded', record: { local: { probes: [] }, services: null, settings: null } },
    { name: 'legacy answered no Version menu values', record: { settings: { ping: null, versionMenu: null } } },
    { name: 'the record predates the Version menu values', record: { settings: { ping: false } } },
  ])('answers null when $name', async ({ record }) => {
    if (record !== undefined) writeRecord(JSON.stringify(record));
    expect(await loadLegacyServerInfo()).toBeNull();
  });

  it.each([
    { name: 'is no JSON', write: () => writeRecord('{"settings":'), error: SyntaxError },
    { name: 'mistypes a value', write: () => writeRecord(JSON.stringify({ settings: { versionMenu: { ...ORACLE_MENU, dbProductName: 7 } } })), error: Error },
    { name: 'cannot be read', write: () => mkdirSync(path.join(stateDir, 'baseline', 'environment.json'), { recursive: true }), error: Error },
  ])('rejects when the record $name', async ({ write, error }) => {
    write();
    await expect(loadLegacyServerInfo()).rejects.toBeInstanceOf(error);
  });
});
