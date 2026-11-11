import { fastify, type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_UMBRELLA_SITE_ID,
  InvalidWritePositionError,
  WRITE_POSITION_HEADER,
  WRITE_POSITION_HEADER_LC,
  compareXid,
  formatWritePosition,
  hasWritePositionHeader,
  mergeWritePosition,
  parseWritePosition,
  recordWritePositionsFrom,
  registerWritePositionHeader,
  resolveTenant,
  type ResolvedTenant,
  type TenantSource,
  type WritePositions,
} from '../../src/migration-kit/index.js';
import { currentRequestContext, newRequestContext, recordWritePosition, runWithRequestContext } from '../../src/service-kit/index.js';
import { TENANT_A, TENANT_UMBRELLA } from '../../src/testing/index.js';
import {
  CHANGELOG_TABLE,
  CHANGE_OPS,
  CHANGE_ORIGINS,
  GATE_PHASES,
  GATE_STATES,
  MIGRATION_BATCH_TABLE,
  MIGRATION_WATERMARK_TABLE,
  OPEN_OPERATION_TABLE,
  PLATFORM_INFRA_TABLES,
  UNIT_GATE_TABLE,
  WATERMARK_DIRECTIONS,
  changelogSql,
  isPlatformInfraTable,
  migrationBatchSql,
  migrationKitSql,
  migrationWatermarkSql,
  openOperationSql,
  qualified,
  unitGateSql,
} from '../../src/migration-kit/ddl.js';
import { rlsSql } from '../../src/tenancy/rls.js';

const NO_RLS = /POLICY|ROW LEVEL SECURITY/i;
const TIMESTAMP = 'timestamp(3) without time zone NOT NULL DEFAULT localtimestamp(3)';

const INVALID_IDENTIFIERS: readonly (readonly [string, string])[] = [
  ['upper-case letters', 'People'],
  ['a double quote', 'people"'],
  ['a statement separator', 'people; DROP TABLE people.person; --'],
  ['a schema-qualified name', 'people.person'],
  ['whitespace', 'people person'],
  ['a hyphen', 'programs-sites'],
  ['a leading digit', '1people'],
  ['an empty string', ''],
  ['a non-string value', 42 as unknown as string],
];

const GENERATORS: readonly (readonly [string, (schema: string) => string])[] = [
  ['changelogSql', changelogSql],
  ['unitGateSql', unitGateSql],
  ['openOperationSql', openOperationSql],
  ['migrationBatchSql', migrationBatchSql],
  ['migrationWatermarkSql', migrationWatermarkSql],
  ['migrationKitSql', migrationKitSql],
];

function lines(sql: string): string[] {
  return sql.split('\n');
}

describe('migration-kit table names and value sets', () => {
  it('names the five migration-kit tables', () => {
    expect([CHANGELOG_TABLE, UNIT_GATE_TABLE, OPEN_OPERATION_TABLE, MIGRATION_BATCH_TABLE, MIGRATION_WATERMARK_TABLE]).toEqual([
      'changelog',
      'unit_gate',
      'open_operation',
      'migration_batch',
      'migration_watermark',
    ]);
  });

  it.each<readonly [string, readonly string[], readonly string[]]>([
    ['CHANGE_OPS', CHANGE_OPS, ['insert', 'update', 'delete']],
    ['CHANGE_ORIGINS', CHANGE_ORIGINS, ['target', 'legacy-window', 'migration-feed', 'backfill']],
    ['GATE_STATES', GATE_STATES, ['legacy', 'open', 'closed']],
    ['GATE_PHASES', GATE_PHASES, ['quiet', 'executing', 'importing', 'import-pending']],
    ['WATERMARK_DIRECTIONS', WATERMARK_DIRECTIONS, ['forward', 'reverse']],
  ])('lists %s in order', (_name, values, expected) => {
    expect(values).toEqual(expected);
  });
});

describe('isPlatformInfraTable', () => {
  it('lists the platform-written service tables in a frozen array', () => {
    expect(Object.isFrozen(PLATFORM_INFRA_TABLES)).toBe(true);
    expect(PLATFORM_INFRA_TABLES).toEqual([
      'outbox',
      'inbox',
      'consumer_aggregate_version',
      'changelog',
      'scheduled_task_queue',
      'scheduled_task_queue_state',
      'migration_batch',
      'migration_watermark',
      'unit_gate',
      'open_operation',
      'tenant_registry',
      'tenant_grant',
    ]);
  });

  it.each(PLATFORM_INFRA_TABLES)('accepts %s', (table) => {
    expect(isPlatformInfraTable(table)).toBe(true);
  });

  it.each(['person', 'Outbox', 'people.outbox', ''])('rejects %j', (table) => {
    expect(isPlatformInfraTable(table)).toBe(false);
  });
});

describe('qualified', () => {
  it('double-quotes the schema and the table', () => {
    expect(qualified('people', 'person')).toBe('"people"."person"');
    expect(qualified('programs_sites', '_site2')).toBe('"programs_sites"."_site2"');
  });

  it.each(INVALID_IDENTIFIERS)('throws a TypeError for a schema with %s', (_case, name) => {
    expect(() => qualified(name, 'person')).toThrow(new TypeError(`Invalid schema identifier: ${JSON.stringify(name)}`));
  });

  it.each(INVALID_IDENTIFIERS)('throws a TypeError for a table with %s', (_case, name) => {
    expect(() => qualified('people', name)).toThrow(new TypeError(`Invalid table identifier: ${JSON.stringify(name)}`));
  });
});

describe('changelogSql', () => {
  const sql = changelogSql('people');

  it('creates the tenant-owned changelog keyed by tenant and sequence', () => {
    expect(lines(sql).slice(0, 4)).toEqual([
      'CREATE TABLE people.changelog (',
      '  tenant_id uuid NOT NULL,',
      '  xid xid8 NOT NULL DEFAULT pg_current_xact_id(),',
      '  seq bigserial NOT NULL,',
    ]);
    expect(lines(sql)).toEqual(
      expect.arrayContaining([
        '  "table" text NOT NULL,',
        "  op text NOT NULL CHECK (op IN ('insert','update','delete')),",
        '  key text NOT NULL,',
        "  columns text[] NOT NULL DEFAULT '{}',",
        "  origin text NOT NULL CHECK (origin IN ('target','legacy-window','migration-feed','backfill')),",
        '  actor_user_id text,',
        '  actor_service text,',
        `  at ${TIMESTAMP},`,
        '  request_id text,',
        '  operation_id text,',
        '  PRIMARY KEY (tenant_id, seq),',
      ]),
    );
  });

  it('requires the before and after images each operation carries', () => {
    expect(sql).toContain(
      [
        "  CHECK ((op = 'insert' AND before IS NULL AND after IS NOT NULL)",
        "      OR (op = 'update' AND before IS NOT NULL AND after IS NOT NULL)",
        "      OR (op = 'delete' AND before IS NOT NULL AND after IS NULL))",
        ');',
      ].join('\n'),
    );
  });

  it('indexes the commit-safe cursor and open operations', () => {
    expect(lines(sql)).toEqual(
      expect.arrayContaining([
        'CREATE INDEX changelog_cursor_idx ON people.changelog (tenant_id, xid, seq);',
        'CREATE INDEX changelog_operation_idx ON people.changelog (tenant_id, operation_id) WHERE operation_id IS NOT NULL;',
      ]),
    );
  });

  it('ends with the tenant RLS of people.changelog and a newline', () => {
    expect(sql.endsWith(`\n${rlsSql('people', 'changelog')}\n`)).toBe(true);
  });
});

describe('unitGateSql', () => {
  it('creates the non-tenant gate with legacy and quiet defaults and a holder exactly while closed', () => {
    expect(unitGateSql('people')).toBe(
      [
        'CREATE TABLE people.unit_gate (',
        '  unit text PRIMARY KEY,',
        "  state text NOT NULL DEFAULT 'legacy' CHECK (state IN ('legacy','open','closed')),",
        '  holder_id text,',
        "  phase text NOT NULL DEFAULT 'quiet' CHECK (phase IN ('quiet','executing','importing','import-pending')),",
        `  updated_at ${TIMESTAMP},`,
        "  CHECK ((state = 'closed') = (holder_id IS NOT NULL))",
        ');',
        '',
      ].join('\n'),
    );
  });
});

describe('openOperationSql', () => {
  it('creates the non-tenant operation registry with a GIN index on its units', () => {
    expect(openOperationSql('people')).toBe(
      [
        'CREATE TABLE people.open_operation (',
        '  operation_id text PRIMARY KEY,',
        '  kind text NOT NULL,',
        '  units text[] NOT NULL,',
        `  started_at ${TIMESTAMP}`,
        ');',
        'CREATE INDEX open_operation_units_idx ON people.open_operation USING gin (units);',
        '',
      ].join('\n'),
    );
  });
});

describe('migrationBatchSql', () => {
  const sql = migrationBatchSql('people');

  it('creates the tenant-owned batch record keyed by tenant and batch, for migration origins only', () => {
    expect(lines(sql).slice(0, 9)).toEqual([
      'CREATE TABLE people.migration_batch (',
      '  tenant_id uuid NOT NULL,',
      '  batch_id text NOT NULL,',
      '  legacy_table text NOT NULL,',
      "  origin text NOT NULL CHECK (origin IN ('backfill','migration-feed','legacy-window')),",
      '  row_count integer NOT NULL,',
      `  applied_at ${TIMESTAMP},`,
      '  PRIMARY KEY (tenant_id, batch_id)',
      ');',
    ]);
  });

  it('ends with the tenant RLS of people.migration_batch and a newline', () => {
    expect(sql).toBe(`${lines(sql).slice(0, 9).join('\n')}\n${rlsSql('people', 'migration_batch')}\n`);
  });
});

describe('migrationWatermarkSql', () => {
  it('creates the non-tenant watermark keyed by legacy table and direction', () => {
    expect(migrationWatermarkSql('people')).toBe(
      [
        'CREATE TABLE people.migration_watermark (',
        '  legacy_table text NOT NULL,',
        "  direction text NOT NULL CHECK (direction IN ('forward','reverse')),",
        '  snapshot_seq bigint,',
        '  backup_lsn numeric(25,0),',
        '  finished_at timestamp(3) without time zone NOT NULL,',
        '  PRIMARY KEY (legacy_table, direction)',
        ');',
        '',
      ].join('\n'),
    );
  });
});

describe.each([
  ['unitGateSql', unitGateSql],
  ['openOperationSql', openOperationSql],
  ['migrationWatermarkSql', migrationWatermarkSql],
] as const)('%s tenancy', (_name, generate) => {
  it('declares no tenant column and no RLS', () => {
    expect(generate('people')).not.toContain('tenant_id');
    expect(generate('people')).not.toMatch(NO_RLS);
  });
});

describe('migrationKitSql', () => {
  const sql = migrationKitSql('people');

  it('joins the five tables in order, separated by blank lines', () => {
    expect(sql).toBe(
      [changelogSql, unitGateSql, openOperationSql, migrationBatchSql, migrationWatermarkSql]
        .map((generate) => generate('people'))
        .join('\n'),
    );
    expect(sql.split('\n\n')).toHaveLength(5);
    expect([...sql.matchAll(/^CREATE TABLE (\S+) \($/gm)].map((match) => match[1])).toEqual([
      'people.changelog',
      'people.unit_gate',
      'people.open_operation',
      'people.migration_batch',
      'people.migration_watermark',
    ]);
  });

  it('applies tenant RLS to changelog and migration_batch only', () => {
    expect(sql).toContain(rlsSql('people', 'changelog'));
    expect(sql).toContain(rlsSql('people', 'migration_batch'));
    expect([...sql.matchAll(/^CREATE POLICY \S+ ON (\S+)$/gm)].map((match) => match[1])).toEqual([
      'people.changelog',
      'people.migration_batch',
    ]);
  });

  it('uses the given schema throughout', () => {
    const other = migrationKitSql('programs_sites');
    expect(other).toBe(sql.replaceAll('people.', 'programs_sites.'));
    expect(other).not.toContain('people');
  });
});

describe.each(GENERATORS)('%s schema identifier', (_name, generate) => {
  it.each(INVALID_IDENTIFIERS)('throws a TypeError for %s', (_case, name) => {
    expect(() => generate(name)).toThrow(new TypeError(`Invalid schema identifier: ${JSON.stringify(name)}`));
  });
});

// Mapping rules are tested in mapping.test.ts; this block only binds resolveTenant to the shared tenant fixtures.
describe('resolveTenant against the tenant fixtures', () => {
  const lookups = {
    umbrellaSiteId: DEFAULT_UMBRELLA_SITE_ID,
    parentSiteId: (table: string, key: Record<string, unknown>) =>
      table === 'tusers' && key.UserID === 'U-A' ? TENANT_A.siteId : null,
  };
  const parent: TenantSource = { kind: 'parent', parentLegacyTable: 'tusers', columns: { UserID: 'UserID' } };
  const inTenantA: ResolvedTenant = { tenantId: TENANT_A.tenantId, siteId: TENANT_A.siteId, orphan: false };
  const orphan: ResolvedTenant = { tenantId: TENANT_UMBRELLA.tenantId, siteId: TENANT_UMBRELLA.siteId, orphan: true };

  it.each<readonly [string, TenantSource, Record<string, unknown>, ResolvedTenant]>([
    ['a siteID row of tenant-a to TENANT_A', { kind: 'site', column: 'SiteID' }, { SiteID: 'tenant-a' }, inTenantA],
    ['a child row without siteID to its tenant-a parent', parent, { UserID: 'U-A' }, inTenantA],
    ['a child row of an unknown parent to the umbrella as an orphan', parent, { UserID: 'U-missing' }, orphan],
  ])('resolves %s', (_case, source, row, expected) => {
    expect(resolveTenant(source, row, lookups)).toEqual(expected);
  });
});

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('write-position header name', () => {
  it('is X-Opt2-Write-Position, lower-cased for header maps', () => {
    expect(WRITE_POSITION_HEADER).toBe('X-Opt2-Write-Position');
    expect(WRITE_POSITION_HEADER_LC).toBe('x-opt2-write-position');
  });
});

describe('compareXid', () => {
  it.each<readonly [string | bigint, string | bigint, -1 | 0 | 1]>([
    ['9', '10', -1],
    ['10', '9', 1],
    ['10', '10', 0],
    ['007', '7', 0],
    [9n, '10', -1],
    ['9007199254740993', '9007199254740992', 1],
  ])('compares %s with %s as %d', (left, right, expected) => {
    expect(compareXid(left, right)).toBe(expected);
  });
});

describe('formatWritePosition', () => {
  it.each<readonly [string, WritePositions | Record<string, string>, string]>([
    ['a map', new Map([['people', '10'], ['identity', '9']]), 'identity=9,people=10'],
    ['a record', { 'strategies-content': '5', identity: '3' }, 'identity=3,strategies-content=5'],
    ['no positions', new Map(), ''],
  ])('formats %s with entries sorted by owner', (_case, positions, expected) => {
    expect(formatWritePosition(positions)).toBe(expected);
  });
});

describe('parseWritePosition', () => {
  it('round-trips a formatted header value', () => {
    const positions = parseWritePosition('identity=9,people=10');
    expect([...positions]).toEqual([
      ['identity', '9'],
      ['people', '10'],
    ]);
    expect(formatWritePosition(positions)).toBe('identity=9,people=10');
  });

  it.each<readonly [string, string | string[] | undefined, readonly (readonly [string, string])[]]>([
    ['an absent header', undefined, []],
    ['an empty value', '', []],
    ['empty elements and surrounding whitespace', ' people=10 , ,identity=9,', [['people', '10'], ['identity', '9']]],
    ['a repeated owner, keeping the highest xid', 'people=10,people=9,people=11', [['people', '11']]],
    ['the values of a repeated header', ['people=10', 'identity=9,people=12'], [['people', '12'], ['identity', '9']]],
    ['leading zeros as a plain decimal', 'people=007', [['people', '7']]],
  ])('parses %s', (_case, value, expected) => {
    expect([...parseWritePosition(value)]).toEqual(expected);
  });

  it.each(['people', 'people=abc', '=1', 'people=', 'People=1', '-people=1', 'people=-1', 'people=1.5', 'people=1=2'])(
    'throws InvalidWritePositionError naming the malformed entry %j',
    (entry) => {
      const error = thrownBy(() => parseWritePosition(`identity=9, ${entry}`));
      expect(error).toBeInstanceOf(InvalidWritePositionError);
      expect(error).toMatchObject({
        name: 'InvalidWritePositionError',
        entry,
        message: `Invalid X-Opt2-Write-Position entry: ${JSON.stringify(entry)}`,
      });
    },
  );
});

describe('mergeWritePosition', () => {
  it.each([
    ['9', '10', '10'],
    ['10', '9', '10'],
    ['9007199254740993', '9007199254740992', '9007199254740993'],
    ['9007199254740992', '9007199254740993', '9007199254740993'],
  ])('keeps the higher of %s and %s by BigInt value: %s', (first, second, expected) => {
    expect([...mergeWritePosition(new Map([['people', first]]), new Map([['people', second]]))]).toEqual([['people', expected]]);
  });

  it('unions owners, skips undefined sets and leaves its inputs unchanged', () => {
    const people: WritePositions = new Map([['people', '10']]);
    const identity: WritePositions = new Map([
      ['identity', '9'],
      ['people', '3'],
    ]);
    const merged = mergeWritePosition(people, undefined, identity);
    expect(formatWritePosition(merged)).toBe('identity=9,people=10');
    expect(merged).not.toBe(people);
    expect([...people]).toEqual([['people', '10']]);
    expect([...identity]).toEqual([
      ['identity', '9'],
      ['people', '3'],
    ]);
    expect(mergeWritePosition().size).toBe(0);
  });
});

describe('recordWritePositionsFrom', () => {
  it('records every position of a downstream header in the active request context, keeping the highest', () => {
    const store = newRequestContext({ requestId: 'write-position-unit' });
    runWithRequestContext(store, () => {
      recordWritePosition('people', '12');
      recordWritePositionsFrom(['identity=9,people=10', 'people=11']);
    });
    expect([...store.writePositions]).toEqual([
      ['people', '12'],
      ['identity', '9'],
    ]);
  });

  it('is a no-op outside a request', () => {
    expect(currentRequestContext()).toBeUndefined();
    expect(() => recordWritePositionsFrom('people=10')).not.toThrow();
  });

  it('rejects a malformed header inside and outside a request', () => {
    expect(() => recordWritePositionsFrom('people=abc')).toThrow(InvalidWritePositionError);
    expect(() => runWithRequestContext(newRequestContext(), () => recordWritePositionsFrom('people=abc'))).toThrow(
      InvalidWritePositionError,
    );
  });
});

describe('registerWritePositionHeader', () => {
  const apps: FastifyInstance[] = [];
  const publicRoute = { config: { opt2: { public: true } } } as const;

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  function bareApp(): FastifyInstance {
    const app = fastify();
    apps.push(app);
    return app;
  }

  function contextApp(): FastifyInstance {
    const app = bareApp();
    app.addHook('onRequest', (request, _reply, done) => {
      runWithRequestContext(newRequestContext({ requestId: request.id }), () => done());
    });
    registerWritePositionHeader(app);
    app.get('/write', publicRoute, async () => {
      recordWritePosition('people', '42');
      return { ok: true };
    });
    app.get('/roster-write', publicRoute, async () => {
      recordWritePosition('people', '10');
      recordWritePosition('identity', '9');
      recordWritePosition('people', '8');
      return { ok: true };
    });
    app.get('/read', publicRoute, async () => ({ ok: true }));
    return app;
  }

  it.each([
    ['/write', 'people=42'],
    ['/roster-write', 'identity=9,people=10'],
    ['/read', undefined],
  ])('answers %s with write position %s', async (url, expected) => {
    const res = await contextApp().inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(res.headers[WRITE_POSITION_HEADER_LC]).toBe(expected);
  });

  it('emits no header for a request served without a request context', async () => {
    const app = bareApp();
    registerWritePositionHeader(app);
    app.get('/read', publicRoute, async () => ({ ok: true }));
    const res = await app.inject({ method: 'GET', url: '/read' });
    expect(res.statusCode).toBe(200);
    expect(res.headers).not.toHaveProperty(WRITE_POSITION_HEADER_LC);
  });

  it('adds its onSend hook once per app instance', () => {
    const app = bareApp();
    const addHook = vi.spyOn(app, 'addHook');
    registerWritePositionHeader(app);
    registerWritePositionHeader(app);
    expect(addHook).toHaveBeenCalledTimes(1);
    expect(addHook).toHaveBeenCalledWith('onSend', expect.any(Function));
  });
});

describe('hasWritePositionHeader', () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function withChild(registerOn: 'root' | 'child'): Promise<{ root: FastifyInstance; child: FastifyInstance }> {
    const root = fastify();
    apps.push(root);
    let child: FastifyInstance | undefined;
    if (registerOn === 'root') registerWritePositionHeader(root);
    await root.register(async (instance) => {
      child = instance;
      if (registerOn === 'child') registerWritePositionHeader(instance);
    });
    await root.ready();
    if (child === undefined) throw new Error('plugin did not load');
    return { root, child };
  }

  it('is false for an app without the hook', () => {
    const app = fastify();
    apps.push(app);
    expect(hasWritePositionHeader(app)).toBe(false);
  });

  it('is true for the registering app and every instance encapsulated from it', async () => {
    const { root, child } = await withChild('root');
    expect(hasWritePositionHeader(root)).toBe(true);
    expect(hasWritePositionHeader(child)).toBe(true);
  });

  it('is true for an encapsulated registrant but not for its parent', async () => {
    const { root, child } = await withChild('child');
    expect(hasWritePositionHeader(child)).toBe(true);
    expect(hasWritePositionHeader(root)).toBe(false);
  });
});

