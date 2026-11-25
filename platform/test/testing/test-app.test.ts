import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { INVOCATION_HEADER, LOCAL_SECRET_FILES, decodeJwt, localSecretPath } from '../../src/auth/index.js';
import { loadEnv } from '../../src/service-kit/index.js';
import { InvalidTaskNameError, outboxSweepQueue, type CreateTaskInput } from '../../src/tasks/index.js';
import type { QueryResult } from '../../src/tenancy/index.js';
import {
  CLIENT_ROUTE_KEY, LOCAL_TEST_PORTS, POOL_ENDED_MESSAGE, TENANT_A, TENANT_B, clientPathPattern, closingParen, collapseSql, createFakeTaskPort,
  createHeadersFor, createTestStateDir, fakePoolTenantDb, localTestEnv, localTestUrl, pathWithoutQuery, splitTopLevel, type LocalTestEnvOptions,
} from '../../src/testing/index.js';

const fsFaults = vi.hoisted((): { writeFile?: Error } => ({}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: async (...args: Parameters<typeof actual.writeFile>) => (fsFaults.writeFile ? Promise.reject(fsFaults.writeFile) : actual.writeFile(...args)) };
});

const SWEEP = outboxSweepQueue('people');
const BASE: LocalTestEnvOptions = { service: 'people', database: { name: 'opt2_people_test', user: 'people_app' }, callees: ['identity', 'strategies-content'], stateDir: '/var/state' };
const PORTS_ENV_TEXT = readFileSync(new URL('../../../harness/repro/ports.env', import.meta.url), 'utf8');
const PORTS_ENV = Object.fromEntries([...PORTS_ENV_TEXT.matchAll(/^OPT2_PORT_([A-Z_]+)=(\d+)$/gm)].map(([, name = '', port]) => [name.toLowerCase().replaceAll('_', '-'), Number(port)]));
const task = (name: string, queue: string = SWEEP): CreateTaskInput => ({ queue, name, scheduleTime: new Date(0), url: 'http://127.0.0.1:8112/internal/v1/outbox/sweep', deadlineS: 60 });
const claims = (bearer = ''): Record<string, unknown> => decodeJwt(bearer.replace(/^Bearer /, ''));
const made: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  delete fsFaults.writeFile;
});
afterAll(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('test-app helpers', () => {
  it.each<[string, () => unknown, unknown]>([
    ['LOCAL_TEST_PORTS holds the ports harness/repro/ports.env assigns', () => LOCAL_TEST_PORTS, PORTS_ENV],
    ['localTestUrl addresses a workload or a port', () => [localTestUrl('stub'), localTestUrl(8102)], ['http://127.0.0.1:8199', 'http://127.0.0.1:8102']],
    ['localTestEnv gives variables loadEnv accepts', () => loadEnv(undefined, localTestEnv(BASE)).PORT, 8112],
    ['clientPathPattern matches a {name} within one segment and other text literally, whole', () => ['/a.b/U-1', '/a.b/U-1/x', '/aXb/U-1'].map((url) => clientPathPattern('/a.b/{id}').test(url)), [true, false, false]],
    ['clientPathPattern returns a RegExp as given', () => clientPathPattern(CLIENT_ROUTE_KEY) === CLIENT_ROUTE_KEY, true],
    ['CLIENT_ROUTE_KEY reads the method and path of a client handler', () => [CLIENT_ROUTE_KEY.exec('PATCH /v1/x/{id}')?.slice(1), CLIENT_ROUTE_KEY.test('HEAD /v1/x')], [['PATCH', '/v1/x/{id}'], false]],
    ['pathWithoutQuery drops the query', () => [pathWithoutQuery('/v1/x?a=1'), pathWithoutQuery('/v1/x')], ['/v1/x', '/v1/x']],
    ['collapseSql collapses whitespace runs and trims', () => collapseSql('  SELECT *\n\t FROM  t  '), 'SELECT * FROM t'],
    ['closingParen skips nested parentheses and, by default, single-quoted text', () => [closingParen('x (a (b) c)', 2), closingParen("(a, ')', c)", 0)], [10, 10]],
    ['closingParen skips only the quotes given and gives -1 when unbalanced', () => [closingParen('(a, ")", c)', 0), closingParen('(a, ")", c)', 0, '\'"'), closingParen('(a, (b)', 0)], [5, 10, -1]],
    ['splitTopLevel splits at top-level commas, trimming and dropping empty parts', () => splitTopLevel(" f(a, b), 'x, y' ,, c"), ['f(a, b)', "'x, y'", 'c']],
    ['splitTopLevel skips only the quotes given', () => [splitTopLevel('"a,b", c'), splitTopLevel('"a,b", c', '\'"')], [['"a', 'b"', 'c'], ['"a,b"', 'c']]],
  ])('%s', (_label, run, expected) => {
    expect(run()).toStrictEqual(expected);
  });

  it.each(['nobody', 'constructor'])('localTestUrl throws a TypeError for the unknown workload %s', (name) => {
    expect(() => localTestUrl(name)).toThrow(new TypeError(`No local test port for ${name}`));
  });

  it.each<[string, Record<string, string>, Partial<LocalTestEnvOptions>, Record<string, string | undefined>, Record<string, string | undefined>]>([
    ['the local-mode variables', { TZ: 'UTC' }, {}, {}, { PORT: '8112', PG_HOST: '127.0.0.1', PG_DATABASE: 'opt2_people_test', PG_PASSWORD: 'unused', OPT2_STATE_DIR: '/var/state', TZ: 'UTC' }],
    ['the callee URLs in order', {}, {}, {}, { OPT2_ENV: 'local', OPT2_SERVICE_URLS: '{"identity":"http://127.0.0.1:8111","strategies-content":"http://127.0.0.1:8114"}' }],
    ['the PG_* variables set in process.env when asked', { PG_HOST: 'db.test', PG_DATABASE: '' }, { pgFromProcessEnv: true }, {}, { PG_HOST: 'db.test', PG_DATABASE: 'opt2_people_test' }],
    ['no PG_* variable of process.env unless asked', { PG_HOST: 'db.test' }, {}, {}, { PG_HOST: '127.0.0.1' }],
    ['the port, extra variables, then overrides, an undefined one deleting the variable', { TZ: '' }, { port: 9000, extra: { OPT2_ENV: 'x', GOOGLE_CLOUD_PROJECT: 'p' } }, { GOOGLE_CLOUD_PROJECT: 'q', PG_PASSWORD: undefined }, { PORT: '9000', OPT2_ENV: 'x', GOOGLE_CLOUD_PROJECT: 'q', PG_PASSWORD: undefined, TZ: 'UTC' }],
  ])('localTestEnv gives %s', (_label, processEnv, options, overrides, expected) => {
    for (const [name, value] of Object.entries(processEnv)) vi.stubEnv(name, value);
    const env = localTestEnv({ ...BASE, ...options }, overrides);
    expect(Object.fromEntries(Object.keys(expected).map((name) => [name, env[name]]))).toEqual(expected);
  });

  it('localTestEnv calls a state-directory function only when the overrides leave OPT2_STATE_DIR unset', () => {
    const stateDir = vi.fn(() => '/var/made');
    const dirs = [{}, { OPT2_STATE_DIR: '/var/given' }, { OPT2_STATE_DIR: undefined }].map((overrides) => localTestEnv({ ...BASE, stateDir }, overrides).OPT2_STATE_DIR);
    expect([dirs, stateDir.mock.calls.length]).toEqual([['/var/made', '/var/given', undefined], 1]);
  });

  it.each([
    ['a subject name on tenant-a', createHeadersFor({ audience: 'people' }), {}, { site: TENANT_A.siteId, sub: 'test-member' }, 'people'],
    ['the site default given', createHeadersFor({ audience: 'people', site: TENANT_B.siteId }), {}, { site: TENANT_B.siteId }, 'people'],
    ['the site, audience and sub of the call', createHeadersFor({ audience: 'people', site: TENANT_B.siteId }), { site: TENANT_A.siteId, audience: 'identity', sub: 'U-1' }, { site: TENANT_A.siteId, sub: 'U-1' }, 'identity'],
  ])('createHeadersFor presents %s and rejects an unknown subject name', async (_label, headersFor, options, user, audience) => {
    const headers = await headersFor('member', options);
    expect(claims(headers.authorization)).toMatchObject(user);
    expect(claims(headers[INVOCATION_HEADER])).toMatchObject({ aud: audience, sub: 'service:gateway' });
    await expect(headersFor('nobody')).rejects.toThrow(new TypeError('ROLE_SET has no subject named nobody'));
  });

  it('createTestStateDir makes a directory under the OS temp directory holding the test secrets', async () => {
    const dir = await createTestStateDir('opt2-own-prefix-');
    made.push(dir);
    expect([path.dirname(dir), path.basename(dir).startsWith('opt2-own-prefix-')]).toEqual([tmpdir(), true]);
    expect(Object.values(LOCAL_SECRET_FILES).filter((file) => !existsSync(localSecretPath(dir, file)))).toEqual([]);
  });

  it('createTestStateDir removes the directory when the secrets cannot be written', async () => {
    const prefix = `opt2-unwritable-${process.pid}-`;
    fsFaults.writeFile = new Error('disk full');
    await expect(createTestStateDir(prefix)).rejects.toThrow('disk full');
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith(prefix))).toEqual([]);
  });

  it('createFakeTaskPort creates each (queue, name) once, a deleted one included, and fails the creates failCreate names after their input check', async () => {
    const port = createFakeTaskPort();
    const other = outboxSweepQueue('identity');
    const results = [await port.create(task('a')), await port.create(task('a')), await port.delete(SWEEP, 'a'), await port.create(task('a'))];
    expect(results).toEqual([{ name: 'a', created: true }, { name: 'a', created: false }, { name: 'a', deleted: true }, { name: 'a', created: false }]);
    port.failCreate(SWEEP, 2);
    await expect(port.create(task('bad name'))).rejects.toThrow(InvalidTaskNameError);
    await expect(port.create(task('b'))).rejects.toThrow(`fake task port: injected create failure on ${SWEEP}/b`);
    expect(await port.create(task('i', other))).toEqual({ name: 'i', created: true });
    await expect(port.create(task('b'))).rejects.toThrow('injected create failure');
    port.failCreate();
    await expect(port.create(task('j', other))).rejects.toThrow('injected create failure');
    expect(await port.create(task('b'))).toEqual({ name: 'b', created: true });
    expect([...port.tasks].map(([key, { deleted }]) => [key, deleted])).toEqual([[`${SWEEP}/a`, true], [`${other}/i`, false], [`${SWEEP}/b`, false]]);
    expect(port.created).toStrictEqual([...port.tasks.values()]);
  });

  it('fakePoolTenantDb runs each transaction through run on a connection of its own and refuses connections and statements after end unless told not to', async () => {
    const statements: Array<[session: number, sql: string, params: unknown[]]> = [];
    const released: number[] = [];
    let sessions = 0;
    const run = async (session: number, sql: string, params: unknown[]): Promise<QueryResult> => {
      statements.push([session, sql, params]);
      return { command: (/^\w+/.exec(sql)?.[0] ?? '').toUpperCase(), rowCount: 1, oid: 0, fields: [], rows: [{ answer: sql }] };
    };
    const pool = (options: { refuseAfterEnd?: boolean } = {}) => fakePoolTenantDb({ schema: 'people', session: () => ++sessions, release: (session) => void released.push(session), run, ...options });
    const db = pool();
    expect(db.schema).toBe('people');
    expect(await db.withTenant(TENANT_A.tenantId, async (tx) => (await tx.query('SELECT $1::int', [1])).rows[0])).toEqual({ answer: 'SELECT $1::int' });
    expect(await db.withMetadata(async (tx) => (await tx.query({ text: 'SELECT 2', values: [2] })).rowCount)).toBe(1);
    expect([released, statements.filter(([, sql]) => /^SELECT (\$1|2)/.test(sql))]).toEqual([[1, 2], [[1, 'SELECT $1::int', [1]], [2, 'SELECT 2', [2]]]]);
    expect(statements.some(([, , params]) => params.includes(TENANT_A.tenantId))).toBe(true);
    await expect(db.withMetadata(async (tx) => { await db.end(); return tx.query('SELECT 3'); })).rejects.toThrow(POOL_ENDED_MESSAGE);
    await expect(db.withMetadata(async () => 'ran')).rejects.toThrow(POOL_ENDED_MESSAGE);
    const lenient = pool({ refuseAfterEnd: false });
    await lenient.end();
    await expect(lenient.withMetadata(async () => 'ran')).resolves.toBe('ran');
  });
});
