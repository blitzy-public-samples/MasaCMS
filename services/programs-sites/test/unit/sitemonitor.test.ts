/** Site monitor on the composed app without PostgreSQL: real passes through buildApp's own client, task port and cursor store. */
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLOUD_TASKS_HEADERS,
  SITEMONITOR_INTERVAL_S,
  SITEMONITOR_QUEUE,
  queueDefinition,
  slotName,
  slotStartS,
  successorSlotS,
  taskWireBody,
} from '@opt2/platform/tasks';
import type { ServiceRequest } from '@opt2/platform/service-kit';
import { mintTasksInvokerToken } from '@opt2/platform/testing';
import { formatLegacyTime } from '../../src/jobs/dispatch.js';
import { SITE_MONITOR_STEPS, type SiteMonitorStepName } from '../../src/jobs/steps.js';
import {
  TEST_CLOCK,
  buildTestApp,
  createRecordingDb,
  type FakeTaskRecord,
  type RecordingDb,
  type TestApp,
} from '../helpers/app.js';

const MINUTE_MS = 60_000;
const TASK_PATH = '/internal/v1/jobs/sitemonitor';
const LEGACY_STEPS_PATH = '/internal/v1/legacy-steps';
const AUTHORITY_PATH = '/internal/v1/authority';
const CURSOR_TABLE = '"programs_sites"."sitemonitor_state"';
const THE_TIME = TEST_CLOCK.now();
const DEADLINE_AT = new Date(THE_TIME.getTime() + queueDefinition(SITEMONITOR_QUEUE).deadlineS * 1000);
// No cursor row yet: legacy's cfparam default, contentServer.cfc:676.
const DEFAULT_CURSOR = new Date(THE_TIME.getTime() - MINUTE_MS);
const CATCH_UP = new Date(THE_TIME.getTime() - 30 * MINUTE_MS);

// A first pass with no registered site: 11:59 and 11:30 differ in minute-of-hour, so reminders run twice.
const FIRST_PASS: ReadonlyArray<readonly [SiteMonitorStepName, Date]> = [
  ['sendReminders', CATCH_UP],
  ['sendReminders', THE_TIME],
  ['emailSend', THE_TIME],
  ['publishScheduledChangesets', THE_TIME],
  ['purgeDisplayWindow', THE_TIME],
  ['clearOldCommands', THE_TIME],
  ['onGlobalMonitor', THE_TIME],
  ['setCursor', THE_TIME],
];

/** The `sitemonitor_state` row the fake keeps across transactions. */
type CursorRow = Record<string, unknown>;

/** A registered site and the `programs_sites.site` columns the monitor reads. */
interface RegisteredSite {
  tenantId: string;
  siteid: string;
  emailbroadcaster: number;
  feedmanager: number;
  mailserverusername: string;
  orderno: number;
}

/**
 * Recording database whose cursor row persists across transactions, answering the platform repository's statements on
 * it, and whose tenant registry and site table hold `sites`.
 */
function cursorDb(sites: readonly RegisteredSite[]): { db: RecordingDb; row: () => CursorRow | undefined } {
  let row: CursorRow | undefined;
  const db = createRecordingDb();
  db.respond(/^SELECT tenant_id, site_id FROM programs_sites\.tenant_registry /i, () =>
    sites.map((site) => ({ tenant_id: site.tenantId, site_id: site.siteid })),
  );
  db.respond(/^SELECT \* FROM "programs_sites"\."site" WHERE /i, (params) =>
    sites
      .filter((site) => site.tenantId === params[0] && site.siteid === params[1])
      .map(({ tenantId, ...site }) => ({ tenant_id: tenantId, ...site })),
  );
  const on = (verb: string): RegExp => new RegExp(`^${verb} ${CURSOR_TABLE.replace(/[."]/g, '\\$&')} `, 'i');
  db.respond(on('SELECT \\* FROM'), () => (row === undefined ? [] : [{ ...row }]));
  // ON CONFLICT DO NOTHING: an existing row inserts nothing.
  db.respond(on('INSERT INTO'), (params, sql) => {
    if (row !== undefined) return [];
    const columns = (/\(([^)]*)\) VALUES/i.exec(sql)?.[1] ?? '').split(',').map((column) => column.trim().replace(/"/g, ''));
    const inserted: CursorRow = { last_monitored: null, lease_id: null, lease_until: null };
    columns.forEach((column, i) => {
      inserted[column] = params[i];
    });
    row = inserted;
    return [{ ...inserted }];
  });
  db.respond(on('UPDATE'), (params, sql) => {
    if (row === undefined) return [];
    const assignments = /\bSET (.+?) WHERE /i.exec(sql)?.[1] ?? '';
    for (const [, column, index] of assignments.matchAll(/"(\w+)" = \$(\d+)/g)) {
      if (column !== undefined && index !== undefined) row[column] = params[Number(index) - 1];
    }
    return [{ ...row }];
  });
  return { db, row: () => row };
}

/** Wire body the dispatcher posts to migration for one legacy step of a first pass. */
function legacyStepBody(step: SiteMonitorStepName, at: Date): Record<string, unknown> {
  return {
    step,
    theTime: formatLegacyTime(at),
    lastMonitored: formatLegacyTime(DEFAULT_CURSOR),
    deadlineAt: DEADLINE_AT.toISOString(),
  };
}

/** `LocalTimestamp` of the run-result contract: the legacy wall-clock text with a `T` separator. */
function localTimestamp(at: Date): string {
  return formatLegacyTime(at).replace(' ', 'T');
}

/** Bodies of the legacy-step calls the app made to migration, in call order. */
function stepBodies(test: TestApp): unknown[] {
  return test.client.requestsTo('migration', LEGACY_STEPS_PATH).map((call) => call.json);
}

/** Statements that named the cursor table. */
function cursorStatements(db: RecordingDb): string[] {
  return db
    .statements()
    .map((statement) => statement.sql)
    .filter((sql) => sql.includes(CURSOR_TABLE));
}

/** Composed app with its cursor row and the tasks created after start-up, which already holds the outbox-sweep chain. */
interface ComposedApp extends TestApp {
  cursor: () => CursorRow | undefined;
  tasksSinceStartup: () => FakeTaskRecord[];
}

let open: TestApp | undefined;

async function composedApp(sites: readonly RegisteredSite[] = []): Promise<ComposedApp> {
  const { db, row } = cursorDb(sites);
  const test = await buildTestApp({ db });
  open = test;
  db.clear();
  const startupTasks = test.taskPort.tasks().length;
  return { ...test, cursor: row, tasksSinceStartup: () => test.taskPort.tasks().slice(startupTasks) };
}

afterEach(async () => {
  await open?.app.close();
  open = undefined;
});

describe('public /_api/sitemonitor on the composed app', () => {
  it.each([
    ['GET', '/_api/sitemonitor'],
    ['POST', '/_api/sitemonitor'],
    ['GET', '/index.cfm/_api/sitemonitor/'],
  ] as const)('%s %s runs a first pass on legacy, stores the cursor at theTime and answers ""', async (method, url) => {
    const test = await composedApp();

    const res = await test.app.inject({ method, url });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    expect(stepBodies(test)).toEqual(FIRST_PASS.map(([step, at]) => legacyStepBody(step, at)));
    expect(test.tasksSinceStartup()).toEqual([]);
    expect(test.cursor()).toMatchObject({ last_monitored: THE_TIME, lease_id: null, lease_until: null });
  });

  // A decision-list unit (legacy:tcontenteventreminders) never moves, so no authority answer routes these steps.
  it('keeps the target-capable steps on legacy whatever authority migration reports', async () => {
    const site: RegisteredSite = {
      tenantId: '6b1f3c2a-9d4e-5f60-8a7b-1c2d3e4f5a6b',
      siteid: 'tenant-a',
      emailbroadcaster: 0,
      feedmanager: 1,
      mailserverusername: '',
      orderno: 1,
    };
    const test = await composedApp([site]);
    const targetCapable = SITE_MONITOR_STEPS.filter((step) => step.targetPath !== undefined);
    test.client.setAuthority([...targetCapable.flatMap((step) => step.units), 'content.file'], 'target');

    const res = await test.app.inject({ method: 'GET', url: '/_api/sitemonitor' });

    expect(res.statusCode).toBe(200);
    expect(test.client.requestsTo('migration', AUTHORITY_PATH)).toEqual([]);
    expect(test.tasksSinceStartup()).toEqual([]);
    expect(stepBodies(test)).toEqual(
      expect.arrayContaining([
        legacyStepBody('publishScheduledChangesets', THE_TIME),
        { ...legacyStepBody('feedAutoImport', THE_TIME), siteId: 'tenant-a' },
      ]),
    );
  });

  // contentServer.cfc:676 stores the cfparam default before any step, so a failed first pass keeps it.
  it('answers 503 when a legacy step fails, stops there and keeps the default cursor', async () => {
    const test = await composedApp();
    test.client.failStep('emailSend');

    const res = await test.app.inject({ method: 'GET', url: '/_api/sitemonitor' });

    expect(res.statusCode).toBe(503);
    expect(stepBodies(test)).toEqual(FIRST_PASS.slice(0, 3).map(([step, at]) => legacyStepBody(step, at)));
    expect(test.cursor()).toMatchObject({ last_monitored: DEFAULT_CURSOR, lease_id: null, lease_until: null });
  });
});

describe(`POST ${TASK_PATH} on the composed app`, () => {
  const nowS = Math.floor(THE_TIME.getTime() / 1000);
  const slot = slotStartS(nowS, SITEMONITOR_INTERVAL_S);
  const successor = slotName(SITEMONITOR_QUEUE, successorSlotS(slot, nowS, SITEMONITOR_INTERVAL_S));

  /** Delivers the current slot's chain task as the local Cloud Tasks adapter would. */
  async function invokeChainTask(test: TestApp) {
    const name = slotName(SITEMONITOR_QUEUE, slot);
    const body = taskWireBody({
      queue: SITEMONITOR_QUEUE,
      name,
      scheduleTime: new Date(slot * 1000),
      url: `${selfUrl(test)}${TASK_PATH}`,
      body: { slotStartS: slot },
      deadlineS: queueDefinition(SITEMONITOR_QUEUE).deadlineS,
    });
    return test.app.inject({
      method: 'POST',
      url: TASK_PATH,
      headers: {
        authorization: `Bearer ${await mintTasksInvokerToken({ audience: 'programs-sites' })}`,
        'content-type': 'application/json',
        [CLOUD_TASKS_HEADERS.taskName]: name,
        [CLOUD_TASKS_HEADERS.queueName]: SITEMONITOR_QUEUE,
        [CLOUD_TASKS_HEADERS.retryCount]: '0',
        [CLOUD_TASKS_HEADERS.executionCount]: '0',
        [CLOUD_TASKS_HEADERS.eta]: String(slot),
      },
      payload: body,
    });
  }

  /** programs-sites' own URL from the app's `OPT2_SERVICE_URLS`. */
  function selfUrl(test: TestApp): string {
    const urls = JSON.parse(test.env.OPT2_SERVICE_URLS ?? '{}') as Record<string, string>;
    return urls['programs-sites'] ?? '';
  }

  it('creates the next slot on the service URL before the first step, then answers the run result', async () => {
    const test = await composedApp();
    const chainAtFirstStep: string[][] = [];
    test.client.on('migration', 'POST', LEGACY_STEPS_PATH, (req: ServiceRequest) => {
      if (chainAtFirstStep.length === 0) chainAtFirstStep.push(test.taskPort.tasks(SITEMONITOR_QUEUE).map((t) => t.input.name));
      const step = (req.json as { step: string }).step;
      return { status: 200, headers: {}, body: { step, completed: true, serverTime: THE_TIME.toISOString() } };
    });

    const res = await invokeChainTask(test);

    expect(res.statusCode).toBe(200);
    expect(chainAtFirstStep).toEqual([[successor]]);
    const created = test.tasksSinceStartup();
    expect(created.map((task) => task.input)).toEqual([
      expect.objectContaining({ queue: SITEMONITOR_QUEUE, name: successor, url: `${selfUrl(test)}${TASK_PATH}` }),
    ]);
    expect(created[0]?.input.tenantId).toBeUndefined();
    expect(res.json()).toEqual({
      theTime: localTimestamp(THE_TIME),
      lastMonitored: localTimestamp(DEFAULT_CURSOR),
      steps: FIRST_PASS.map(([step, at]) => ({ step, routedTo: 'legacy', status: 'completed', theTime: localTimestamp(at) })),
    });
    expect(test.cursor()).toMatchObject({ last_monitored: THE_TIME });
  });

  it('answers the legacy 503 and runs no step and touches no cursor when the successor cannot be created', async () => {
    const test = await composedApp();
    test.taskPort.failCreate((input) => input.queue === SITEMONITOR_QUEUE);

    const res = await invokeChainTask(test);

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'server_error', message: 'Unhandled Exception' } });
    expect(test.client.requests).toEqual([]);
    expect(test.tasksSinceStartup()).toEqual([]);
    expect(cursorStatements(test.db)).toEqual([]);
    expect(test.cursor()).toBeUndefined();
  });
});
