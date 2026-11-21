// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Template store domain as the fixture communications.cfc answers it: create checks, param defaults, the audit actor and the site-scoped paged list. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LegacyApiError } from '@opt2/platform/legacy-compat';
import type { WriteContext } from '@opt2/platform/migration-kit';
import type { QueryConfig, QueryResult, QueryResultRow, TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, fixedClock } from '@opt2/platform/testing';
import { createTemplate, listTemplates, type TemplateFilters, type TemplateInput } from '../../src/domain/templates.js';
import * as queries from '../../src/repo/queries.js';
import { createCommunicationsRepository, type CommunicationsRepository, type NewTemplate } from '../../src/repo/repository.js';
import type { MessageTemplateRow } from '../../src/repo/tables.js';

vi.mock(import('../../src/repo/queries.js'), async (importOriginal) => ({ ...(await importOriginal()), listTemplates: vi.fn() }));

const NOW = new Date(2026, 5, 30, 14, 5, 9, 123);
const TEMPLATE_ID = '11111111-2222-3333-4444555566667777';
const VALID: TemplateInput = { name: 'Welcome', subject: 'Hello {{name}}', bodyText: 'Text', bodyHtml: '<p>Html</p>' };
const TEXT_ONLY: TemplateInput = { name: 'Welcome', subject: 'Hello', bodyText: 'Text' };

interface RecordingTx {
  tx: TenantTx;
  statements: string[];
}

interface InsertCall {
  tx: TenantTx;
  input: NewTemplate;
  ctx: WriteContext | undefined;
}

/** A tenant transaction that records every statement and answers none. */
function recordingTx(tenantId: string = TENANT_A.tenantId): RecordingTx {
  const statements: string[] = [];
  const tx: TenantTx = {
    kind: 'tenant',
    tenantId,
    schema: 'communications',
    onCommit: () => undefined,
    query<R extends QueryResultRow = QueryResultRow>(text: string | QueryConfig): Promise<QueryResult<R>> {
      statements.push(typeof text === 'string' ? text : text.text);
      return Promise.reject(new Error('the template domain issues no SQL of its own'));
    },
  };
  return { tx, statements };
}

/** The communications repository with insertTemplate recording its calls and answering the row it would store. */
function recordingRepository(): { repository: CommunicationsRepository; inserts: InsertCall[] } {
  const inserts: InsertCall[] = [];
  const repository: CommunicationsRepository = {
    ...createCommunicationsRepository({ clock: fixedClock(NOW) }),
    insertTemplate: (tx, input, ctx) => {
      inserts.push({ tx, input, ctx });
      return Promise.resolve({
        tenant_id: tx.tenantId,
        template_id: TEMPLATE_ID,
        siteid: input.siteId,
        name: input.name,
        subject: input.subject,
        body_text: input.bodyText,
        body_html: input.bodyHtml,
        created: NOW,
        lastupdate: NOW,
      });
    },
  };
  return { repository, inserts };
}

function templateRow(n: number): MessageTemplateRow {
  return {
    tenant_id: TENANT_A.tenantId,
    template_id: `${String(n).padStart(8, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`,
    siteid: TENANT_A.siteId,
    name: `Template ${String(n)}`,
    subject: 'Hello',
    body_text: 'Text',
    body_html: '',
    created: NOW,
    lastupdate: NOW,
  };
}

describe('createTemplate', () => {
  it('stores the template under the token site with every value as received and returns the stored row', async () => {
    const { tx, statements } = recordingTx();
    const { repository, inserts } = recordingRepository();
    const input: TemplateInput = {
      name: ' Welcome ',
      subject: ' Hello {{name}} ',
      bodyText: '  Line 1\r\nLine 2  ',
      bodyHtml: '<p> Hi </p>\n',
      siteid: TENANT_B.siteId,
    };

    const row = await createTemplate(tx, { repository, clock: fixedClock(NOW) }, { siteId: TENANT_A.siteId, userId: 'U1', input });

    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.tx).toBe(tx);
    expect(inserts[0]?.input).toStrictEqual({
      siteId: TENANT_A.siteId,
      name: ' Welcome ',
      subject: ' Hello {{name}} ',
      bodyText: '  Line 1\r\nLine 2  ',
      bodyHtml: '<p> Hi </p>\n',
    });
    expect(row).toStrictEqual({
      tenant_id: TENANT_A.tenantId,
      template_id: TEMPLATE_ID,
      siteid: TENANT_A.siteId,
      name: ' Welcome ',
      subject: ' Hello {{name}} ',
      body_text: '  Line 1\r\nLine 2  ',
      body_html: '<p> Hi </p>\n',
      created: NOW,
      lastupdate: NOW,
    });
    expect(statements).toStrictEqual([]);
  });

  it.each<[string, WriteContext | undefined, WriteContext]>([
    ['without a caller context', undefined, { actorUserId: 'U1' }],
    [
      'beside the caller request context',
      { requestId: 'req-1', actorService: 'communications' },
      { actorUserId: 'U1', requestId: 'req-1', actorService: 'communications' },
    ],
    ['unless the caller context names one', { actorUserId: 'U2', origin: 'legacy-window' }, { actorUserId: 'U2', origin: 'legacy-window' }],
  ])('records the token user as the changelog actor %s', async (_label, context, expected) => {
    const { tx } = recordingTx();
    const { repository, inserts } = recordingRepository();

    await createTemplate(tx, { repository, clock: fixedClock(NOW) }, { siteId: TENANT_A.siteId, userId: 'U1', input: VALID, context });

    expect(inserts[0]?.ctx).toStrictEqual(expected);
  });

  it.each<[string, TemplateInput, Partial<NewTemplate>]>([
    ['an absent html body as empty', TEXT_ONLY, {}],
    ['a null text body as empty', { ...TEXT_ONLY, bodyText: null, bodyHtml: '<p/>' }, { bodyText: '', bodyHtml: '<p/>' }],
    ['a body of only spaces as a body', { ...TEXT_ONLY, bodyText: ' ' }, { bodyText: ' ' }],
    ['params ignoring case', { NAME: 'Welcome', Subject: 'Hello', BODYTEXT: 'Text', bodyhtml: '<p/>' }, { bodyHtml: '<p/>' }],
    ['the later of two keys differing in case', { ...TEXT_ONLY, NAME: 'Second' }, { name: 'Second' }],
    ['a number as its text', { ...TEXT_ONLY, name: 2026 }, { name: '2026' }],
    [
      'a 100-character name and a 255-character subject',
      { ...TEXT_ONLY, name: 'n'.repeat(100), subject: 's'.repeat(255) },
      { name: 'n'.repeat(100), subject: 's'.repeat(255) },
    ],
  ])('reads %s', async (_label, input, expected) => {
    const { tx } = recordingTx();
    const { repository, inserts } = recordingRepository();

    await createTemplate(tx, { repository, clock: fixedClock(NOW) }, { siteId: TENANT_A.siteId, userId: 'U1', input });

    expect(inserts[0]?.input).toStrictEqual({ siteId: TENANT_A.siteId, ...TEXT_ONLY, bodyHtml: '', ...expected });
  });

  it.each<[string, TemplateInput]>([
    ['no name', { subject: 'Hello', bodyText: 'Text' }],
    ['a name of only spaces and control characters', { ...VALID, name: ' \t\r\n\u0001 ' }],
    ['a name over 100 characters', { ...VALID, name: 'n'.repeat(101) }],
    ['a name over 100 UTF-16 code units', { ...VALID, name: '\u{1F600}'.repeat(51) }],
    ['no subject', { name: 'Welcome', bodyText: 'Text' }],
    ['a subject of only spaces', { ...VALID, subject: '   ' }],
    ['a subject over 255 characters', { ...VALID, subject: 's'.repeat(256) }],
    ['no body', { name: 'Welcome', subject: 'Hello' }],
    ['two empty bodies', { ...VALID, bodyText: '', bodyHtml: null }],
    ['an object name', { ...VALID, name: { first: 'Welcome' } }],
    ['an array body', { ...VALID, bodyHtml: ['<p/>'] }],
  ])('answers invalidParameters for %s without writing', async (_label, input) => {
    const { tx } = recordingTx();
    const { repository, inserts } = recordingRepository();

    const created = createTemplate(tx, { repository, clock: fixedClock(NOW) }, { siteId: TENANT_A.siteId, userId: 'U1', input });

    await expect(created).rejects.toBeInstanceOf(LegacyApiError);
    await expect(created).rejects.toMatchObject({ type: 'invalidParameters' });
    expect(inserts).toStrictEqual([]);
  });
});

describe('listTemplates', () => {
  const listed = vi.mocked(queries.listTemplates);

  beforeEach(() => {
    listed.mockReset();
    listed.mockResolvedValue({ items: [templateRow(1), templateRow(2)], total: 7 });
  });

  it('reads the first 50 templates of the token site in the caller transaction by default', async () => {
    const { tx, statements } = recordingTx();

    const page = await listTemplates(tx, { siteId: TENANT_A.siteId });

    expect(listed.mock.calls).toStrictEqual([[tx, { siteId: TENANT_A.siteId, pageIndex: 1, itemsPerPage: 50 }]]);
    expect(page).toStrictEqual({ list: [templateRow(1), templateRow(2)], pageIndex: 1, itemsPerPage: 50, totalItems: 7 });
    expect(statements).toStrictEqual([]);
  });

  it('scopes each tenant transaction to the token site whatever site the request params name', async () => {
    const a = recordingTx(TENANT_A.tenantId);
    const b = recordingTx(TENANT_B.tenantId);

    await listTemplates(a.tx, { siteId: TENANT_A.siteId, siteid: TENANT_B.siteId, SITEID: TENANT_B.siteId });
    await listTemplates(b.tx, { siteId: TENANT_B.siteId, siteid: TENANT_A.siteId });

    expect(listed.mock.calls).toStrictEqual([
      [a.tx, { siteId: TENANT_A.siteId, pageIndex: 1, itemsPerPage: 50 }],
      [b.tx, { siteId: TENANT_B.siteId, pageIndex: 1, itemsPerPage: 50 }],
    ]);
  });

  it.each<[string, Omit<TemplateFilters, 'siteId'>, number, number]>([
    ['text paging params', { pageIndex: '2', itemsPerPage: '10' }, 2, 10],
    ['paging params ignoring case at the 1000-row limit', { PAGEINDEX: '3', ITEMSPERPAGE: '1000' }, 3, 1000],
    ['a numeric page index', { pageindex: 4 }, 4, 50],
    ['empty and null paging params as their defaults', { pageIndex: '', itemsPerPage: null }, 1, 50],
  ])('pages by %s', async (_label, params, pageIndex, itemsPerPage) => {
    const { tx } = recordingTx();

    const page = await listTemplates(tx, { ...params, siteId: TENANT_A.siteId });

    expect(listed.mock.calls).toStrictEqual([[tx, { siteId: TENANT_A.siteId, pageIndex, itemsPerPage }]]);
    expect(page).toMatchObject({ pageIndex, itemsPerPage, totalItems: 7 });
  });

  it.each<[string, Omit<TemplateFilters, 'siteId'>]>([
    ['a zero page index', { pageIndex: '0' }],
    ['a negative page index', { pageIndex: '-1' }],
    ['a fractional page index', { pageIndex: '1.5' }],
    ['a non-numeric page index', { pageIndex: 'abc' }],
    ['zero items per page', { itemsPerPage: '0' }],
    ['over 1000 items per page', { itemsPerPage: '1001' }],
  ])('answers invalidParameters for %s without reading', async (_label, params) => {
    const { tx } = recordingTx();

    const page = listTemplates(tx, { ...params, siteId: TENANT_A.siteId });

    await expect(page).rejects.toBeInstanceOf(LegacyApiError);
    await expect(page).rejects.toMatchObject({ type: 'invalidParameters' });
    expect(listed).not.toHaveBeenCalled();
  });
});
