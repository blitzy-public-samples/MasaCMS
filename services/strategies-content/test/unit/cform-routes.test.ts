/** The cform routes of routes/v1/cform.ts through `app.inject`, against bodies recorded from Masa 7.6.1 on ACF 2023 (test/fixtures/legacy-cform-recorded.json). */
import { readFileSync } from 'node:fs';
import { crc32, inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Roles, moduleRole } from '@opt2/platform/auth';
import { isCfUuid } from '@opt2/platform/legacy-compat';
import {
  CSRF_CONSUME_PATH,
  legacyParamsOf,
  sendLegacyResponse,
  type FastifyInstance,
  type FastifyRequest,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import { TENANT_A, TENANT_B } from '@opt2/platform/testing';
import { CONTENT_CONFIG_DEFAULTS, actorFromClaims } from '../../src/domain/context.js';
import { acfStructKeyOrder } from '../../src/legacy/admin-render.js';
import { createContentRepository } from '../../src/repo/repository.js';
import type { ContentRouteContext } from '../../src/routes/index.js';
import { circuitRouteConfig, requireCircuitAccess } from '../../src/routes/v1/access.js';
import { cformRawActions, registerFormRoutes } from '../../src/routes/v1/cform.js';
import { TEST_CLOCK, buildContentApp, createRecordingDb, userHeaders, type ContentTestApp } from '../helpers/app.js';

interface Recorded {
  contentTypes: { json: string; html: string };
  templates: Record<string, string>;
  missing: Record<string, string>;
  beans: { action: string; input: Record<string, string>; body: string }[];
}

const recorded = JSON.parse(readFileSync(new URL('../fixtures/legacy-cform-recorded.json', import.meta.url), 'utf8')) as Recorded;

const SITE = TENANT_A.siteId;
const USER = 'U0000001-AAAA-BBBB-CCCCDDDDEEEEFFFF';
const FORM_ID = 'F0000001-AAAA-BBBB-CCCCDDDDEEEEFFFF';
const m = (digits: string): string => moduleRole(`00000000000000000000000000000000${digits}`);
const FORM_ROLES = [m('000'), m('004')];
const CF_UUID = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{16}/g;

/** Recorded action names as the contract's raw segments, and recorded input names as the request fields legacy reads. */
const RAW_ACTION: Readonly<Record<string, string>> = { getForm: 'getform', getField: 'getfield', getFieldType: 'getfieldtype', getDataset: 'getdataset' };
const FIELD_NAME: Readonly<Record<string, string>> = {
  formId: 'formID',
  fieldId: 'fieldID',
  fieldType: 'fieldType',
  fieldTypeId: 'fieldTypeID',
  datasetId: 'datasetID',
};

/** The golden normaliser's id rule: CF UUIDs become ordinal placeholders per body. */
function normaliseIds(body: string): string {
  const seen = new Map<string, number>();
  return body.replace(CF_UUID, (id) => {
    if (!seen.has(id)) seen.set(id, seen.size + 1);
    return `<id:${String(seen.get(id))}>`;
  });
}

type Part = { name: string; value: string } | { name: string; filename: string; type: string; data: Buffer };

/** A multipart/form-data payload of `parts` in order. */
function multipart(parts: readonly Part[]): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----opt2-cform-test';
  const chunks = parts.flatMap((part) =>
    'data' in part
      ? [
          Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.type}\r\n\r\n`),
          part.data,
          Buffer.from('\r\n'),
        ]
      : [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`)],
  );
  return { payload: Buffer.concat([...chunks, Buffer.from(`--${boundary}--\r\n`)]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

/** A zip of stored entries, written independently of the route's writer. */
function storedZip(entries: ReadonlyArray<readonly [string, string]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(text);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** The single entry of an archive: name, flags, method and inflated bytes, read through its central directory. */
function onlyEntry(zip: Buffer): { name: string; flags: number; method: number; data: Buffer } {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  expect(zip.readUInt16LE(end + 10)).toBe(1);
  const central = zip.readUInt32LE(end + 16);
  const nameLength = zip.readUInt16LE(central + 28);
  const local = zip.readUInt32LE(central + 42);
  const start = local + 30 + zip.readUInt16LE(local + 26);
  const data = inflateRawSync(zip.subarray(start, start + zip.readUInt32LE(central + 20)));
  expect(crc32(data)).toBe(zip.readUInt32LE(central + 16));
  expect(data.length).toBe(zip.readUInt32LE(central + 24));
  return {
    name: zip.toString('utf8', central + 46, central + 46 + nameLength),
    flags: zip.readUInt16LE(central + 8),
    method: zip.readUInt16LE(central + 10),
    data,
  };
}

describe('routes/v1/cform', () => {
  let t: ContentTestApp;
  const db = createRecordingDb();
  const calls: ServiceRequest[] = [];
  const identity = { rb: 'en' as string | undefined, status: 200, csrfValid: true };
  const ctx = {
    domain: { db, repository: createContentRepository({ clock: TEST_CLOCK, schema: db.schema }), clock: TEST_CLOCK, config: CONTENT_CONFIG_DEFAULTS },
    clock: TEST_CLOCK,
    actorFor: async (request: FastifyRequest) => actorFromClaims(request.opt2Auth.user, 'Test User'),
  } as Pick<ContentRouteContext, 'domain' | 'clock' | 'actorFor'> as ContentRouteContext;

  beforeAll(async () => {
    t = await buildContentApp({
      declare: async (app: FastifyInstance) => {
        // What ./raw.ts does for each entry: the circuit gate on the request's siteid, then the entry, sent unchanged.
        for (const [action, spec] of Object.entries(cformRawActions)) {
          app.route({
            method: ['GET', 'POST'],
            url: `/v1/raw/cform/${action}`,
            config: circuitRouteConfig('cform'),
            handler: async (request, reply) => {
              const actor = await requireCircuitAccess(request, ctx, 'cform', String(legacyParamsOf(request).siteid ?? ''));
              const out = await spec.run(request, ctx, actor);
              return sendLegacyResponse(reply, { status: out.status, headers: { 'content-type': out.contentType, ...out.headers }, body: out.body });
            },
          });
        }
        await registerFormRoutes(app, ctx);
      },
    });
    const request = async (req: ServiceRequest): Promise<ServiceResponse> => {
      calls.push(req);
      if (req.service === 'identity' && req.path === '/v1/sessions/current/admin-state') {
        return { status: identity.status, headers: {}, body: identity.rb === undefined ? {} : { rb: identity.rb } };
      }
      if (req.service === 'identity' && req.path === CSRF_CONSUME_PATH) return { status: 200, headers: {}, body: { valid: identity.csrfValid } };
      throw new Error(`unexpected service call ${req.service} ${req.path}`);
    };
    Object.defineProperty(t.app.opt2.client, 'request', { value: request, writable: true, configurable: true, enumerable: true });
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    db.reset();
    calls.length = 0;
    Object.assign(identity, { rb: 'en', status: 200, csrfValid: true });
  });

  const raw = async (
    action: string,
    opts: { method?: 'GET' | 'POST'; query?: Record<string, string>; form?: Record<string, string>; roles?: readonly string[]; site?: string } = {},
  ) => {
    const headers = await userHeaders({ sub: USER, site: opts.site ?? SITE, roles: opts.roles ?? FORM_ROLES });
    const query = new URLSearchParams({ siteid: SITE, ...opts.query }).toString();
    const form = opts.form === undefined ? undefined : new URLSearchParams(opts.form).toString();
    return t.app.inject({
      method: opts.method ?? (form === undefined ? 'GET' : 'POST'),
      url: `/v1/raw/cform/${action}?${query}`,
      headers: form === undefined ? headers : { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
      ...(form === undefined ? {} : { payload: form }),
    });
  };

  it('keys its entries by the contract raw segments, none consuming a CSRF token', () => {
    expect(Object.keys(cformRawActions).sort()).toEqual(['export', 'getdataset', 'getdialog', 'getfield', 'getfieldtemplate', 'getfieldtype', 'getform']);
    for (const spec of Object.values(cformRawActions)) expect(spec).not.toHaveProperty('csrfContext');
  });

  it.each(recorded.beans.map((bean) => [bean.action, JSON.stringify(bean.input), bean] as const))(
    '%s %s answers the recorded body and content type',
    async (action, _input, bean) => {
      const form = Object.fromEntries(Object.entries(bean.input).map(([key, value]) => [FIELD_NAME[key] ?? key, value]));
      const response = await raw(RAW_ACTION[action] ?? action, { form });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['content-type']).toBe(recorded.contentTypes.json);
      expect(normaliseIds(response.body)).toBe(normaliseIds(bean.body));
    },
  );

  it('gives getDataset a new CF UUID for an empty datasetID, and getForm one for a missing formID', async () => {
    const dataset = (await raw('getdataset', { form: { datasetID: '', fieldID: FORM_ID } })).json<{ datasetid: string }>();
    const form = (await raw('getform')).json<{ formid: string }>();
    expect([isCfUuid(dataset.datasetid), isCfUuid(form.formid)]).toEqual([true, true]);
    expect((await raw('getdataset', { form: { datasetID: FORM_ID, fieldID: FORM_ID } })).json<{ datasetid: string }>().datasetid).toBe(FORM_ID);
  });

  it.each(Object.entries(recorded.templates).filter(([name]) => name !== 'field-nested'))(
    'renders template %s through getfieldtemplate and getdialog as recorded',
    async (name, body) => {
      for (const [action, key] of [
        ['getfieldtemplate', 'fieldtype'],
        ['getdialog', 'dialog'],
      ] as const) {
        const response = await raw(action, { query: { [key]: name } });
        expect([response.statusCode, response.headers['content-type'], response.body]).toEqual([200, recorded.contentTypes.html, body]);
      }
    },
  );

  it.each(Object.entries(recorded.missing))('answers the unknown template %j with the missing-template message', async (name, body) => {
    expect((await raw('getfieldtemplate', { form: { fieldtype: name } })).body).toBe(body);
  });

  it('lists the session site forms in field-nested without the posted formid, only from the form scope', async () => {
    db.respond(/lower\(rtrim\(type\)\) = 'form'/, []);
    const nested = await raw('getfieldtemplate', { form: { fieldType: 'field-nested', formid: FORM_ID } });
    expect([nested.statusCode, nested.body]).toEqual([200, recorded.templates['field-nested']]);
    const query = db.statements.find((s) => /lower\(rtrim\(type\)\) = 'form'/.test(s.sql));
    expect([query?.params, query?.tenantId]).toEqual([[SITE, FORM_ID], TENANT_A.tenantId]);
    // A url formid is not the form scope, so field-nested fails reading form.formid.
    expect((await raw('getdialog', { query: { dialog: 'field-nested', formid: FORM_ID } })).statusCode).toBe(500);
  });

  it.each([
    ['getdialog', {}],
    ['getfieldtemplate', {}],
    ['getfield', { fieldID: FORM_ID }],
    ['getform', { formID: 'nope' }],
    ['export', {}],
  ] as const)('%s fails with the legacy 500 for %j', async (action, query) => {
    expect((await raw(action, { query })).statusCode).toBe(500);
  });

  it('fails with the legacy 500 for a template name that is no simple value', async () => {
    const headers = await userHeaders({ sub: USER, site: SITE, roles: FORM_ROLES });
    const response = await t.app.inject({
      method: 'POST',
      url: `/v1/raw/cform/getdialog?siteid=${SITE}`,
      headers: { ...headers, 'content-type': 'application/json' },
      payload: JSON.stringify({ dialog: { name: 'form-form' } }),
    });
    expect(response.statusCode).toBe(500);
  });

  it('reads labels of the session locale, decoding a bundle with \\u escapes, with en_US behind it', async () => {
    identity.rb = 'de_DE';
    expect((await raw('getdialog', { query: { dialog: 'message-delete-row' } })).body).toBe('<span>Zeile l&ouml;schen?</span>');
    expect((await raw('getdialog', { query: { dialog: 'form-form' } })).body).toContain('Label für Absende-Funktion');
    expect((await raw('getfield', { form: { formID: FORM_ID } })).json<{ label: string }>().label).toBe('Neu: Eingabefeld');
    expect(calls.some((call) => call.method === 'GET' && call.path === '/v1/sessions/current/admin-state')).toBe(true);
    for (const rb of ['zz_ZZ', '../de', undefined]) {
      identity.rb = rb;
      expect((await raw('getfieldtemplate', { query: { fieldtype: 'field-textfield' } })).body).toBe(recorded.templates['field-textfield']);
    }
  });

  it('fails closed when identity cannot answer for the session locale', async () => {
    identity.status = 500;
    expect((await raw('getfield', { form: { formID: FORM_ID } })).statusCode).toBe(503);
  });

  it.each([
    [[m('004')], 403],
    [[m('000')], 403],
    [[Roles.siteAdmin], 200],
    [[Roles.s2], 200],
  ] as const)('applies the cform gate for %j with %i', async (roles, status) => {
    expect((await raw('getform', { roles })).statusCode).toBe(status);
  });

  it('denies a siteid other than the token site', async () => {
    expect((await raw('getform', { site: TENANT_B.siteId })).statusCode).toBe(403);
  });

  describe('export', () => {
    const row = { contentid: FORM_ID, contenthistid: FORM_ID, siteid: SITE, type: 'Form', active: 1, title: 'Contact Us! (v2)', body: '{"pages":[]}', responsemessage: 'Thanks', responsesendto: null };

    it('downloads form.json in a ZipOutputStream archive named after the title, date and site', async () => {
      db.respond(/ FROM "content"\."content" tcontent LEFT JOIN /, [row]);
      const response = await raw('export', { query: { contentid: FORM_ID } });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('application/zip');
      expect(response.headers['content-disposition']).toBe(`attachment;filename=contact_us_v2__2026_30_06_${SITE}.zip`);
      const entry = onlyEntry(response.rawPayload);
      expect([entry.name, entry.flags, entry.method]).toEqual(['form.json', 0x0808, 8]);
      const keys = acfStructKeyOrder(['BODY', 'RESPONSEMESSAGE', 'RESPONSESENDTO']);
      const values: Record<string, string> = { BODY: '{"pages":[]}', RESPONSEMESSAGE: 'Thanks', RESPONSESENDTO: '' };
      expect(entry.data.toString('utf8')).toBe(`{${keys.map((key) => `${JSON.stringify(key)}:${JSON.stringify(values[key])}`).join(',')}}`);
    });

    it('exports the new bean of an unknown form', async () => {
      const response = await raw('export', { query: { contentid: FORM_ID } });
      expect(response.headers['content-disposition']).toBe(`attachment;filename=_2026_30_06_${SITE}.zip`);
      expect(JSON.parse(onlyEntry(response.rawPayload).data.toString('utf8'))).toEqual({ BODY: '', RESPONSEMESSAGE: '', RESPONSESENDTO: '' });
    });
  });

  describe('importForm', () => {
    const IMPORT_URL = `/v1/sites/${SITE}/forms/import`;
    const exported = storedZip([['form.json', JSON.stringify({ BODY: '{}', RESPONSEMESSAGE: 'Thanks', RESPONSESENDTO: '' })]]);
    const csrf: Part[] = [
      { name: 'csrf_token', value: 'TOKEN' },
      { name: 'csrf_token_expires', value: '260630120000000' },
    ];

    const post = async (parts: readonly Part[], roles: readonly string[] = FORM_ROLES) => {
      const body = multipart(parts);
      const headers = await userHeaders({ sub: USER, site: SITE, roles });
      return t.app.inject({ method: 'POST', url: IMPORT_URL, headers: { ...headers, ...body.headers }, payload: body.payload });
    };
    const upload = (data: Buffer, title = 'Imported'): Part[] => [
      ...csrf,
      { name: 'title', value: title },
      { name: 'formzip', filename: 'form.zip', type: 'application/zip', data },
    ];
    const csrfCalls = (): number => calls.filter((call) => call.path === CSRF_CONSUME_PATH).length;

    it('re-renders without consuming a token when no file was chosen', async () => {
      const response = await post([...csrf, { name: 'title', value: 'x' }, { name: 'formzip', filename: '', type: 'application/octet-stream', data: Buffer.alloc(0) }]);
      expect([response.statusCode, response.json()]).toEqual([200, { saved: false, errors: {}, redirect: null }]);
      expect(csrfCalls()).toBe(0);
    });

    it('re-renders for an empty form scope and for a JSON body', async () => {
      const headers = await userHeaders({ sub: USER, site: SITE, roles: FORM_ROLES });
      for (const request of [
        { headers, payload: '' },
        { headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify({ formzip: 'x', title: 'y' }) },
      ]) {
        const response = await t.app.inject({ method: 'POST', url: IMPORT_URL, ...request });
        expect([response.statusCode, response.json()]).toEqual([200, { saved: false, errors: {}, redirect: null }]);
      }
    });

    it('sets the alert and writes nothing for a refused token', async () => {
      identity.csrfValid = false;
      const response = await post(upload(exported));
      expect([response.statusCode, response.json()]).toEqual([
        200,
        { saved: false, errors: {}, redirect: null, data: { alert: 'Invalid security token. Please try again.' } },
      ]);
      expect(calls.find((call) => call.path === CSRF_CONSUME_PATH)?.json).toMatchObject({ token: 'TOKEN', context: 'formimport' });
    });

    it.each([
      ['an empty title', upload(exported, ''), 'Title is required'],
      ['a form.json that is no JSON', upload(storedZip([['form.json', '{not json']])), 'Upload did not contain an exported Masa CMS Form'],
    ] as const)('re-renders with the error message for %s', async (_name, parts, errormessage) => {
      const response = await post(parts);
      expect([response.statusCode, response.json()]).toEqual([200, { saved: false, errors: {}, redirect: null, data: { errormessage } }]);
    });

    it.each([
      ['an upload that is no zip', upload(Buffer.from('plain text'))],
      ['an archive without form.json', upload(storedZip([['other.json', '{}']]))],
      ['form.json in a folder', upload(storedZip([['forms/form.json', '{}']]))],
      ['an entry climbing out of the folder', upload(storedZip([['form.json', '{"body":"","responseMessage":"","responseSendTo":""}'], ['../x.json', '{}']]))],
      ['a form.json without responseSendTo', upload(storedZip([['form.json', '{"body":"","responseMessage":""}']]))],
      ['a form.json array', upload(storedZip([['form.json', '[]']]))],
      ['a truncated archive', upload(exported.subarray(0, 40))],
      ['a form without formzip', [...csrf, { name: 'title', value: 'x' }]],
      ['a formzip field that is not a file', [...csrf, { name: 'title', value: 'x' }, { name: 'formzip', value: 'C:\\form.zip' }]],
    ] as const)('fails with the legacy 500 for %s', async (_name, parts) => {
      expect((await post(parts)).statusCode).toBe(500);
    });

    it('fails closed on the save, which needs site settings the service does not hold, after every legacy check passed', async () => {
      // A stored entry, and the deflated one the export writes.
      for (const zip of [exported, (await raw('export', { query: { contentid: FORM_ID } })).rawPayload]) {
        const response = await post(upload(zip));
        expect(response.statusCode, response.body).toBe(503);
      }
      expect(db.statements.some((s) => /^(INSERT|UPDATE|DELETE)/i.test(s.sql))).toBe(false);
    });

    it.each([
      [[m('004')], 403],
      [[m('000')], 403],
    ] as const)('applies the cform gate for %j with %i', async (roles, status) => {
      expect((await post(upload(exported), roles)).statusCode).toBe(status);
    });
  });
});
