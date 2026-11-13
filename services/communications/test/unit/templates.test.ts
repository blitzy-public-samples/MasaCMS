// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Template store through the app over a RecordingDb, as communications.cfc answers GET and POST communications/templates. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isCfUuid } from '@opt2/platform/legacy-compat';
import { TENANT_A, TENANT_B, type TenantFixture } from '@opt2/platform/testing';
import { createTemplate, listTemplates, type TemplateInput } from '../../src/domain/templates.js';
import { fixtureMethod } from '../../src/legacy/fixture-envelope.js';
// The domain needs the real repository over the RecordingDb, and buildTestApp keeps the app's own repository private.
import { createCommunicationsRepository } from '../../src/repo/repository.js';
import { MESSAGE_TEMPLATE, type MessageTemplateRow } from '../../src/repo/tables.js';
import { buildTestApp, createRecordingDb, headersFor, type RecordedTransaction, type TestApp } from '../helpers/app.js';

type Json = Record<string, unknown>;

const FIXTURE_TEMPLATES = '/legacy-fixtures/cfml/api.cfm/communications/templates';
const V1_TEMPLATES = '/v1/templates';
const SENDER = 'communications.sender';
const USER_ID = '11111111-2222-3333-4444555566667777';
const CSRF_HEADERS = { 'x-csrf_token': 'CSRF-TOKEN', 'x-csrf_token_expires': '260630140509000' };
const AT = new Date(2026, 5, 30, 14, 5, 9, 123);
const AT_TEXT = '2026-06-30T14:05:09';
const VALID = { name: 'Welcome', subject: 'Hello {{name}}', bodyText: 'Hi {{name}}' };
const INVALID_PARAMETERS = { code: 'invalid_request', message: 'Invalid parameters' };
const TEMPLATE_KEYS = ['template_id', 'siteid', 'name', 'subject', 'body_text', 'body_html', 'created', 'lastupdate'];
const LIST_KEYS = ['items', 'startindex', 'endindex', 'itemsperpage', 'totalitems', 'totalpages', 'pageindex'];
const WRITE_SQL = /^(?:INSERT|UPDATE|DELETE)\b/i;
const INSERT_TARGET = /^INSERT INTO "?(\w+)"?\."?(\w+)"?/i;

const INVALID: ReadonlyArray<[string, Json]> = [
  ['no name', { subject: VALID.subject, bodyText: VALID.bodyText }],
  ['a blank name', { ...VALID, name: '   ' }],
  ['a name over 100 characters', { ...VALID, name: 'n'.repeat(101) }],
  ['no subject', { name: VALID.name, bodyText: VALID.bodyText }],
  ['a blank subject', { ...VALID, subject: ' ' }],
  ['a subject over 255 characters', { ...VALID, subject: 's'.repeat(256) }],
  ['no body', { name: VALID.name, subject: VALID.subject }],
  ['two empty bodies', { ...VALID, bodyText: '', bodyHtml: '' }],
  ['an object name', { ...VALID, name: { first: 'Welcome' } }],
];

describe('template store', () => {
  let current: number;
  const clock = { now: (): Date => new Date(current) };
  let ctx: TestApp;

  beforeEach(async () => {
    current = AT.getTime();
    ctx = await buildTestApp({ clock });
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  function senderHeaders(tenant: TenantFixture, extra: Record<string, string> = {}): Promise<Record<string, string>> {
    return headersFor(SENDER, { site: tenant.siteId, sub: USER_ID }).then((headers) => ({ ...headers, ...extra }));
  }

  async function post(url: string, payload: Json, tenant: TenantFixture = TENANT_A) {
    return ctx.app.inject({ method: 'POST', url, headers: await senderHeaders(tenant, CSRF_HEADERS), payload });
  }

  async function get(url: string, tenant: TenantFixture = TENANT_A, query: Record<string, string> = {}) {
    return ctx.app.inject({ method: 'GET', url, query, headers: await senderHeaders(tenant) });
  }

  /** Transactions recorded after the first `from` that ran a write statement. */
  function writeTransactions(from: number): RecordedTransaction[] {
    return ctx.db.transactions.slice(from).filter((tx) => tx.statements.some((s) => WRITE_SQL.test(s.text)));
  }

  /** `<schema>.<table>` of each INSERT of `tx`, in order. */
  function insertTargets(tx: RecordedTransaction | undefined): string[] {
    return (tx?.statements ?? []).flatMap((s) => {
      const match = INSERT_TARGET.exec(s.text);
      return match === null ? [] : [`${match[1] ?? ''}.${match[2] ?? ''}`];
    });
  }

  function dataOf(body: unknown): Json {
    return (body as { data: Json }).data;
  }

  describe('fixture routes', () => {
    it('creates a template in the fixture success envelope', async () => {
      const res = await post(FIXTURE_TEMPLATES, VALID);

      expect(res.statusCode).toBe(200);
      const body = res.json<Json>();
      expect(Object.keys(body)).toStrictEqual(['apiversion', 'method', 'data']);
      expect(body).toStrictEqual({
        apiversion: 'v1',
        method: fixtureMethod('templates'),
        data: {
          template_id: expect.any(String),
          siteid: TENANT_A.siteId,
          name: VALID.name,
          subject: VALID.subject,
          body_text: VALID.bodyText,
          body_html: '',
          created: AT_TEXT,
          lastupdate: AT_TEXT,
        },
      });
      expect(fixtureMethod('templates')).toBe('communications.templates');
      expect(Object.keys(dataOf(body))).toStrictEqual(TEMPLATE_KEYS);
      expect(isCfUuid(String(dataOf(body).template_id))).toBe(true);
    });

    it('writes the template and its changelog row in one tenant-a transaction', async () => {
      const before = ctx.db.transactions.length;

      const res = await post(FIXTURE_TEMPLATES, VALID);

      const writes = writeTransactions(before);
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ tenantId: TENANT_A.tenantId, outcome: 'commit' });
      expect(insertTargets(writes[0])).toStrictEqual(['communications.message_template', 'communications.changelog']);

      const templateId = dataOf(res.json()).template_id;
      expect(ctx.db.rows('message_template')).toStrictEqual([
        {
          tenant_id: TENANT_A.tenantId,
          template_id: templateId,
          siteid: TENANT_A.siteId,
          name: VALID.name,
          subject: VALID.subject,
          body_text: VALID.bodyText,
          body_html: '',
          created: AT,
          lastupdate: AT,
        },
      ]);
      const changelog = ctx.db.rows('changelog');
      expect(changelog).toHaveLength(1);
      expect(changelog[0]).toMatchObject({
        tenant_id: TENANT_A.tenantId,
        table: 'message_template',
        op: 'insert',
        origin: 'target',
        actor_user_id: USER_ID,
      });
      expect(res.headers['x-opt2-write-position']).toBe(`communications=${String(changelog[0]?.xid)}`);
    });

    it.each(INVALID)('answers %s as invalidParameters without writing', async (_label, payload) => {
      const before = ctx.db.transactions.length;

      const res = await post(FIXTURE_TEMPLATES, payload);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toStrictEqual({ apiversion: 'v1', method: 'communications.templates', error: INVALID_PARAMETERS });
      expect(writeTransactions(before)).toStrictEqual([]);
      expect(ctx.db.rows('message_template')).toStrictEqual([]);
      expect(ctx.db.rows('changelog')).toStrictEqual([]);
    });

    it('stores a 100-character name and a 255-character subject', async () => {
      const res = await post(FIXTURE_TEMPLATES, { ...VALID, name: 'n'.repeat(100), subject: 's'.repeat(255) });

      expect(res.statusCode).toBe(200);
      expect(dataOf(res.json())).toMatchObject({ name: 'n'.repeat(100), subject: 's'.repeat(255) });
    });

    it("lists the tenant's templates by created, then template_id, in the fixture list shape", async () => {
      current = AT.getTime() + 5000;
      const latest = dataOf((await post(FIXTURE_TEMPLATES, { ...VALID, name: 'Latest' })).json()).template_id;
      current = AT.getTime();
      const earlyIds: string[] = [];
      for (const name of ['First', 'Second']) {
        earlyIds.push(String(dataOf((await post(FIXTURE_TEMPLATES, { ...VALID, name })).json()).template_id));
      }
      earlyIds.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      await post(FIXTURE_TEMPLATES, { ...VALID, name: 'Other tenant' }, TENANT_B);

      const res = await get(FIXTURE_TEMPLATES);

      expect(res.statusCode).toBe(200);
      const body = res.json<Json>();
      expect(Object.keys(body)).toStrictEqual(['apiversion', 'method', 'data']);
      expect(body.method).toBe('communications.templates');
      const data = dataOf(body);
      expect(Object.keys(data)).toStrictEqual(LIST_KEYS);
      expect(data).toMatchObject({ startindex: 1, endindex: 3, itemsperpage: 50, totalitems: 3, totalpages: 1, pageindex: 1 });
      const items = data.items as Json[];
      expect(items.map((item) => item.template_id)).toStrictEqual([...earlyIds, latest]);
      expect(items.map((item) => item.siteid)).toStrictEqual([TENANT_A.siteId, TENANT_A.siteId, TENANT_A.siteId]);
      expect(items.every((item) => Object.keys(item).join() === TEMPLATE_KEYS.join())).toBe(true);
      expect(items.some((item) => item.name === 'Other tenant')).toBe(false);
    });

    it('pages the list by pageIndex and itemsPerPage', async () => {
      for (const name of ['One', 'Two', 'Three']) await post(FIXTURE_TEMPLATES, { ...VALID, name });

      const res = await get(FIXTURE_TEMPLATES, TENANT_A, { pageIndex: '2', itemsPerPage: '2' });

      expect(res.statusCode).toBe(200);
      const data = dataOf(res.json());
      expect(data).toMatchObject({ startindex: 3, endindex: 3, itemsperpage: 2, totalitems: 3, totalpages: 2, pageindex: 2 });
      expect(data.items).toHaveLength(1);
    });

    it.each<[string, Record<string, string>]>([
      ['a zero page index', { pageIndex: '0' }],
      ['over 1000 items per page', { itemsPerPage: '1001' }],
    ])('answers %s as invalidParameters', async (_label, query) => {
      const res = await get(FIXTURE_TEMPLATES, TENANT_A, query);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toStrictEqual({ apiversion: 'v1', method: 'communications.templates', error: INVALID_PARAMETERS });
    });

    it("shows a tenant-b template only in tenant-b's list", async () => {
      const created = dataOf((await post(FIXTURE_TEMPLATES, VALID, TENANT_B)).json());

      const listA = dataOf((await get(FIXTURE_TEMPLATES)).json());
      const listB = dataOf((await get(FIXTURE_TEMPLATES, TENANT_B)).json());

      expect(listA).toMatchObject({ items: [], totalitems: 0, startindex: 1, endindex: 0, totalpages: 0 });
      expect(listB).toMatchObject({ items: [created], totalitems: 1 });
      expect(ctx.db.rows('message_template').map((row) => row.tenant_id)).toStrictEqual([TENANT_B.tenantId]);
    });
  });

  describe('/v1/templates', () => {
    it('creates through the same domain write as the fixture, answering {data}', async () => {
      const fixture = await post(FIXTURE_TEMPLATES, VALID);
      const v1 = await post(V1_TEMPLATES, VALID);

      expect(v1.statusCode).toBe(200);
      const body = v1.json<Json>();
      expect(Object.keys(body)).toStrictEqual(['data']);
      expect(Object.keys(dataOf(body))).toStrictEqual(TEMPLATE_KEYS);
      expect(isCfUuid(String(dataOf(body).template_id))).toBe(true);
      expect({ ...dataOf(body), template_id: '' }).toStrictEqual({ ...dataOf(fixture.json()), template_id: '' });

      const [fromFixture, fromV1] = ctx.db.rows('message_template');
      expect({ ...fromV1, template_id: '' }).toStrictEqual({ ...fromFixture, template_id: '' });
      expect(fromV1?.template_id).toBe(dataOf(body).template_id);
      expect(ctx.db.rows('changelog').map((row) => row.actor_user_id)).toStrictEqual([USER_ID, USER_ID]);
    });

    it('lists the same page as the fixture list, answering {data}', async () => {
      await post(V1_TEMPLATES, VALID);
      await post(V1_TEMPLATES, { ...VALID, name: 'Other tenant' }, TENANT_B);

      const v1 = await get(V1_TEMPLATES);
      const fixture = await get(FIXTURE_TEMPLATES);

      expect(v1.statusCode).toBe(200);
      const body = v1.json<Json>();
      expect(Object.keys(body)).toStrictEqual(['data']);
      expect(body.data).toStrictEqual(dataOf(fixture.json()));
      expect(dataOf(body)).toMatchObject({ totalitems: 1, items: [{ siteid: TENANT_A.siteId, name: VALID.name }] });
    });

    // The /v1 routes leave a domain LegacyApiError to service-kit's legacy error envelope (contract BadRequest),
    // so the type, status and error body match the fixture while the envelope method does not.
    it.each(INVALID)('answers %s with the fixture error type without writing', async (_label, payload) => {
      const fixture = await post(FIXTURE_TEMPLATES, payload);
      const before = ctx.db.transactions.length;

      const v1 = await post(V1_TEMPLATES, payload);

      expect(v1.statusCode).toBe(fixture.statusCode);
      expect(v1.json()).toMatchObject({ apiversion: 'v1', error: (fixture.json() as { error: Json }).error });
      expect((v1.json() as { error: Json }).error).toStrictEqual(INVALID_PARAMETERS);
      expect(writeTransactions(before)).toStrictEqual([]);
      expect(ctx.db.rows('message_template')).toStrictEqual([]);
    });

    it('denies a token without communications.sender with 403', async () => {
      const before = ctx.db.transactions.length;

      const res = await ctx.app.inject({ method: 'GET', url: V1_TEMPLATES, headers: await headersFor('system-user') });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'invalid_request', message: 'Insufficient Account Permissions' } });
      expect(ctx.db.transactions.slice(before).filter((tx) => tx.tenantId !== null)).toStrictEqual([]);
    });
  });

  describe('domain', () => {
    it('creates in a RecordingDb tenant transaction with the clock and the user as changelog actor', async () => {
      const db = createRecordingDb({}, { clock });
      db.setGate(MESSAGE_TEMPLATE.unit, 'open');
      const deps = { repository: createCommunicationsRepository({ clock }), clock };
      const input: TemplateInput = { name: 'Direct', subject: 'Hello', bodyHtml: '<p>Hi</p>' };

      const row: MessageTemplateRow = await db.withTenant(TENANT_A.tenantId, (tx) =>
        createTemplate(tx, deps, { siteId: TENANT_A.siteId, userId: USER_ID, input }),
      );

      expect(row).toStrictEqual({
        tenant_id: TENANT_A.tenantId,
        template_id: expect.any(String),
        siteid: TENANT_A.siteId,
        name: 'Direct',
        subject: 'Hello',
        body_text: '',
        body_html: '<p>Hi</p>',
        created: AT,
        lastupdate: AT,
      });
      expect(isCfUuid(row.template_id)).toBe(true);
      expect(db.rows('changelog')).toMatchObject([{ table: 'message_template', op: 'insert', actor_user_id: USER_ID }]);
      expect(db.transactions).toMatchObject([{ tenantId: TENANT_A.tenantId, outcome: 'commit' }]);

      const page = await db.withTenant(TENANT_A.tenantId, (tx) => listTemplates(tx, { siteId: TENANT_A.siteId }));
      expect(page).toStrictEqual({ list: [row], pageIndex: 1, itemsPerPage: 50, totalItems: 1 });
    });
  });
});
