// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Masa's start-up script protection of url and form params on the fixture and `/v1` template and send routes, over PostgreSQL. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureUnitGates } from '@opt2/platform/migration-kit';
import { withMetadata, withTenant, type TenantDb } from '@opt2/platform/tenancy';
import { TENANT_A, createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { UNITS } from '../../src/repo/tables.js';
import { FIXTURE_PREFIX } from '../../src/routes/fixture.js';
import { buildTestApp, headersFor, type TestApp } from '../helpers/app.js';

const SENDER = 'communications.sender';
const CSRF_HEADERS = { 'x-csrf_token': 'SCRIPT-PROTECTION-TOKEN', 'x-csrf_token_expires': '260630130000000' };
const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));

/** How params travel: a urlencoded form, the query string, or a JSON body, which legacy leaves unscanned. */
type Transport = 'form' | 'query' | 'json';
type Fields = Readonly<Record<string, string>>;

/** Each surface with its templates and messages paths; the fixture names its site in the query. */
const SURFACES: ReadonlyArray<readonly [string, string, string]> = [
  ['the fixture', `${FIXTURE_PREFIX}/templates?siteid=${TENANT_A.siteId}`, `${FIXTURE_PREFIX}/messages?siteid=${TENANT_A.siteId}`],
  ['/v1', '/v1/templates', '/v1/messages'],
];

const PADDED: Fields = { name: '  padded name  ', subject: ' s ', bodyText: ' b ' };
const VECTORS = {
  name: 'Vectors',
  subject: '<script>alert(1)</script>Hi',
  bodyHtml: '<p>x</p><script>alert(1)</script><img src=x onerror=alert(2)>',
} as const satisfies Fields;
const QUERY_SCRIPT: Fields = { name: '<script>x</script>q', subject: 's', bodyText: 'b' };

/** Template cases: transport, params sent, and the stored name, subject, body_text and body_html. */
const TEMPLATE_CASES: ReadonlyArray<readonly [string, Transport, Fields, Fields]> = [
  ['padded text', 'form', PADDED, { name: 'padded name', subject: 's', body_text: 'b', body_html: '' }],
  [
    'script vectors',
    'form',
    VECTORS,
    { name: 'Vectors', subject: '[INVALID]Hi', body_text: '', body_html: '<p>x</p>[INVALID]<img src=x [INVALID]=alert(2)>' },
  ],
  ['a script name', 'query', QUERY_SCRIPT, { name: '[INVALID]q', subject: 's', body_text: 'b', body_html: '' }],
  ['padded text', 'json', PADDED, { name: '  padded name  ', subject: ' s ', body_text: ' b ', body_html: '' }],
  ['script vectors', 'json', VECTORS, { name: VECTORS.name, subject: VECTORS.subject, body_text: '', body_html: VECTORS.bodyHtml }],
];

/** The seeded template's id stands for this in a message case. */
const TEMPLATE_REF = '{template}';
const RECIPIENT = 'rcpt@tenant-a.example';
const LITERAL = { to: ` ${RECIPIENT} `, subject: ' <script>alert(1)</script>Hello ', bodyText: ' Hi ', bodyHtml: '<p onclick=x>Hi</p>' } as const satisfies Fields;
const VARIABLES = '{"name":"<b>Ada</b> onload","n":2}';

/** Message cases: transport, params sent, and the stored and mailed to_address, subject, body_text and body_html. */
const MESSAGE_CASES: ReadonlyArray<readonly [string, Transport, Fields, Fields]> = [
  [
    'literal content',
    'form',
    LITERAL,
    { to_address: RECIPIENT, subject: '[INVALID]Hello', body_text: 'Hi', body_html: '<p [INVALID]=x>Hi</p>' },
  ],
  [
    'a padded template id and a variables JSON string',
    'form',
    { templateId: ` ${TEMPLATE_REF} `, to: RECIPIENT, variables: VARIABLES },
    { to_address: RECIPIENT, subject: 'Hello <b>Ada</b> [INVALID]', body_text: 'Hi <b>Ada</b> [INVALID] #2', body_html: '' },
  ],
  [
    'literal content',
    'json',
    { ...LITERAL, to: RECIPIENT },
    { to_address: RECIPIENT, subject: LITERAL.subject, body_text: LITERAL.bodyText, body_html: LITERAL.bodyHtml },
  ],
  [
    'a template id and a variables JSON string',
    'json',
    { templateId: TEMPLATE_REF, to: RECIPIENT, variables: VARIABLES },
    { to_address: RECIPIENT, subject: 'Hello <b>Ada</b> onload', body_text: 'Hi <b>Ada</b> onload #2', body_html: '' },
  ],
];

/** Paging queries legacy's scan trims: `+` is a space in a query, so `+3` arrives as ' 3'. */
const PAGING_CASES: ReadonlyArray<readonly [string, number, number]> = [
  ['itemsPerPage=+3', 3, 1],
  ['itemsPerPage=%20', 50, 1],
  ['itemsPerPage=+3&pageIndex=%20', 3, 1],
];

const available = await pgAvailable();

describe.skipIf(!available)('script-protected url and form params over PostgreSQL', () => {
  let schema!: ThrowawaySchema;
  let ctx!: TestApp<TenantDb>;
  let templateId = '';

  /** POSTs `fields` to `path` by `transport` as a tenant-a sender. */
  async function send(path: string, transport: Transport, fields: Fields) {
    const headers: Record<string, string> = { ...(await headersFor(SENDER, { site: TENANT_A.siteId })), ...CSRF_HEADERS };
    const encoded = new URLSearchParams(fields).toString();
    let url = path;
    let payload: string | undefined;
    if (transport === 'query') url = `${path}${path.includes('?') ? '&' : '?'}${encoded}`;
    else if (transport === 'form') [headers['content-type'], payload] = ['application/x-www-form-urlencoded', encoded];
    else [headers['content-type'], payload] = ['application/json', JSON.stringify(fields)];
    return ctx.app.inject({ method: 'POST', url, headers, ...(payload === undefined ? {} : { payload }) });
  }

  /** One stored row of `table` by its id column, read under tenant-a's RLS. */
  async function stored(table: string, idColumn: string, id: string, columns: readonly string[]): Promise<Record<string, unknown>> {
    const { rows } = await withTenant(schema.app, TENANT_A.tenantId, (tx) =>
      tx.query<Record<string, unknown>>(`SELECT ${columns.join(', ')} FROM "${schema.schema}".${table} WHERE ${idColumn} = $1`, [id]),
    );
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  beforeAll(async () => {
    schema = await createThrowawaySchema({ service: 'communications', migrationsDir: MIGRATIONS_DIR });
    await ensureUnitGates(schema.app, UNITS);
    await withMetadata(schema.app, (tx) => tx.query(`UPDATE "${schema.schema}".unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`));
    ctx = await buildTestApp({ db: schema.app });
    const seeded = await send(SURFACES[0]![1], 'json', { name: 'Seeded', subject: 'Hello {{name}}', bodyText: 'Hi {{name}} #{{n}}' });
    expect(seeded.statusCode).toBe(200);
    templateId = seeded.json<{ data: { template_id: string } }>().data.template_id;
    for (const name of ['Page 1', 'Page 2', 'Page 3']) {
      expect((await send(SURFACES[0]![1], 'json', { name, subject: 's', bodyText: 'b' })).statusCode).toBe(200);
    }
  });

  afterAll(async () => {
    await ctx?.app.close();
    await schema?.drop();
  });

  it.each(SURFACES.flatMap(([surface, templates]) => TEMPLATE_CASES.map(([name, ...c]) => [surface, name, ...c, templates] as const)))(
    '%s stores a template of %s sent as %s with the values legacy stores',
    async (_surface, _case, transport, fields, expected, path) => {
      const res = await send(path, transport, fields);

      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: Record<string, unknown> }>();
      expect(body.data).toMatchObject(expected);
      expect(await stored('message_template', 'template_id', body.data.template_id as string, Object.keys(expected))).toEqual(expected);
    },
  );

  it.each(SURFACES.flatMap(([surface, templates]) => PAGING_CASES.map((c) => [surface, ...c, templates] as const)))(
    '%s lists templates for %s, trimmed as legacy trims it, as itemsPerPage %i of page %i',
    async (_surface, query, itemsPerPage, pageIndex, path) => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `${path}${path.includes('?') ? '&' : '?'}${query}`,
        headers: await headersFor(SENDER, { site: TENANT_A.siteId }),
      });

      expect(res.statusCode).toBe(200);
      const { data } = res.json<{ data: { items: unknown[]; itemsperpage: number; pageindex: number; totalitems: number } }>();
      const { rows } = await withTenant(schema.app, TENANT_A.tenantId, (tx) =>
        tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${schema.schema}".message_template`),
      );
      expect([data.itemsperpage, data.pageindex, data.totalitems]).toEqual([itemsPerPage, pageIndex, rows[0]?.n]);
      expect(data.items).toHaveLength(Math.min(itemsPerPage, data.totalitems));
      expect(data.totalitems).toBeGreaterThan(3);
    },
  );

  it.each(SURFACES.flatMap(([surface, , messages]) => MESSAGE_CASES.map(([name, ...c]) => [surface, name, ...c, messages] as const)))(
    '%s sends a message of %s sent as %s with the values legacy stores and mails',
    async (_surface, _case, transport, fields, expected, path) => {
      const sent = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.replace(TEMPLATE_REF, templateId)]));
      const mailed = ctx.mail.sent.length;

      const res = await send(path, transport, sent);

      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: Record<string, unknown> }>();
      expect(body.data).toMatchObject({ ...expected, state: 'delivered' });
      expect(await stored('message', 'message_id', body.data.message_id as string, Object.keys(expected))).toEqual(expected);
      expect(ctx.mail.sent.slice(mailed)).toEqual([
        expect.objectContaining({ to: expected.to_address, subject: expected.subject, text: expected.body_text, html: expected.body_html }),
      ]);
    },
  );
});
