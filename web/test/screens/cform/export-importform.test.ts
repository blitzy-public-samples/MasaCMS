// cform.export and cform.importform for the tenant-a site admin: the relayed zip, the Import Form view and its upload.
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toString } from '@/lib/html';
import { exportForm } from '@/screens/cform/export';
import { renderImportForm, submitImportForm } from '@/screens/cform/importform';
import type { ScreenContext, ScreenRequestBody, SubmitResult } from '@/screens/registry';
import { CONTENT_IDS } from '../../fixtures/strategies-content/carch';
import { siteAdminRequest } from '../../helpers/admin-request';
import { fragmentModel, normaliseAdminUrl } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type RecordedRequest } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext } from '../../helpers/screen-context';

type Fields = Readonly<Record<string, string>>;

const SITE = 'tenant-a';
const FORMS_MODULE = '00000000000000000000000000000000004';
const EXPORT_PATH = '/v1/raw/cform/export';
const EXPORT_ROUTE = routeKey('GET', 'strategies-content', EXPORT_PATH);
const IMPORT_PATH = `/v1/sites/${SITE}/forms/import` as const;
const IMPORT_ROUTE = routeKey('POST', 'strategies-content', IMPORT_PATH);
const DISPOSITION = 'attachment;filename=contact_us_form_2026_30_06_tenant-a.zip';
const ZIP = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x0d, 0x0a, 0x1a, 0x80]);
const CSRF_FIELDS: Fields = { csrf_token: FIXED_CSRF.token, csrf_token_expires: FIXED_CSRF.expires };
const LIST_REDIRECT = {
  circuit: 'cArch',
  action: 'list',
  params: [
    ['siteid', SITE],
    ['topid', FORMS_MODULE],
    ['moduleid', FORMS_MODULE],
    ['activeTab', '0'],
  ],
};
const LIST_LOCATION = `?muraAction=cArch.list&siteid=${SITE}&topid=${FORMS_MODULE}&moduleid=${FORMS_MODULE}&activeTab=0`;

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

/** The tenant-a site admin's `cform.<item>` context, `rc.siteid` on tenant-a. */
function contextFor(
  item: 'export' | 'importform',
  rc: Fields = {},
  gateway?: FakeGatewayClient,
  body?: ScreenRequestBody,
): ScreenContext & { gateway: FakeGatewayClient } {
  return makeScreenContext({
    req: siteAdminRequest(SITE, { circuit: 'cform', item, rc: { siteid: SITE, ...rc } }),
    gateway,
    body,
  });
}

/** A multipart body as the browser sends it, with the bytes it carries. */
async function multipart(fields: Fields, file: File): Promise<{ body: ScreenRequestBody; bytes: Buffer }> {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  form.append('formzip', file);
  const request = new Request('http://web.test/admin-actions/cform/importform', { method: 'POST', body: form });
  const blob = await request.blob();
  return {
    body: { contentType: request.headers.get('content-type') ?? '', body: blob, form },
    bytes: Buffer.from(await blob.arrayBuffer()),
  };
}

const zipFile = (): File => new File([ZIP], 'form.zip', { type: 'application/zip' });

/** The fields of a relayed multipart request, parsed back. */
function relayedForm(request: RecordedRequest): Promise<FormData> {
  const headers = { 'content-type': request.headers['content-type'] ?? '' };
  return new Response(new Uint8Array(request.bytes), { headers }).formData();
}

/** The service calls, without identity's token issuance. */
const serviceCalls = (gateway: FakeGatewayClient) =>
  gateway.calls
    .filter((call) => call.service !== 'identity')
    .map(({ service, method, path, query }) => ({ service, method, path, ...(query === undefined ? {} : { query }) }));

/** The markup of a re-render outcome, which carries no status. */
function rerenderedMarkup(result: SubmitResult): string {
  expect(result).toEqual({ kind: 'render', view: { body: expect.anything() } });
  if (result.kind !== 'render') throw new TypeError(`Expected a re-render, got ${result.kind}`);
  return toString(result.view.body);
}

describe('exportForm', () => {
  it('relays the Contact Us Form zip with siteid and contentid only', async () => {
    const gateway = fakeGatewayClient({
      [EXPORT_ROUTE]: {
        status: 200,
        headers: { 'content-type': 'application/zip', 'content-disposition': DISPOSITION },
        body: Buffer.from(ZIP),
      },
    });
    const rc = { contentid: CONTENT_IDS.contactForm, topid: FORMS_MODULE, moduleid: FORMS_MODULE, title: 'x' };

    const result = await exportForm(contextFor('export', rc, gateway));

    expect(serviceCalls(gateway)).toEqual([
      {
        service: 'strategies-content',
        method: 'GET',
        path: EXPORT_PATH,
        query: { siteid: SITE, contentid: CONTENT_IDS.contactForm },
      },
    ]);
    expect(result).toEqual({
      status: 200,
      contentType: 'application/zip',
      body: expect.any(Readable),
      headers: { 'content-disposition': DISPOSITION },
    });
    expect(new Headers(result.headers).get('Content-disposition')).toBe(DISPOSITION);
    expect(Buffer.compare(await buffer(result.body as Readable), ZIP)).toBe(0);
  });

  it('relays an answer without a content type, with its cookies', async () => {
    const setCookies = ['A=1; Path=/', 'B=2; Path=/'];
    const gateway = fakeGatewayClient({
      [EXPORT_ROUTE]: { status: 500, headers: { generator: 'Masa CMS 7.6.1' }, body: Buffer.from('error'), setCookies },
    });

    const result = await exportForm(contextFor('export', { contentid: CONTENT_IDS.contactForm }, gateway));

    expect(result).toEqual({
      status: 500,
      contentType: '',
      body: Buffer.from('error'),
      headers: { generator: 'Masa CMS 7.6.1' },
      setCookies,
    });
  });
});

describe('renderImportForm', () => {
  it('models the heading, back link, CSRF fields, inputs and Import button', async () => {
    const ctx = contextFor('importform');

    const model = fragmentModel(toString(await renderImportForm(ctx)));

    expect(model.headings).toEqual(['Import Form', 'Form Builder']);
    expect(model.headings[0]).toBe(ctx.rb.rbKey('sitemanager.content.importform'));
    expect(model.links).toEqual([
      { href: normaliseAdminUrl(`./?muraAction=cArch.list&siteid=${SITE}`), text: 'Return to Content Manager' },
    ]);
    expect(model.links[0]?.text).toBe(ctx.rb.rbKey('sitemanager.backtositemanager'));
    expect(model.controls.map(({ name, type, value }) => ({ name, type, value }))).toEqual([
      { name: 'csrf_token', type: 'hidden', value: FIXED_CSRF.token },
      { name: 'csrf_token_expires', type: 'hidden', value: FIXED_CSRF.expires },
      { name: 'title', type: 'text', value: '' },
      { name: 'formzip', type: 'file', value: '' },
    ]);
    expect(model.buttons).toEqual([{ text: 'Import', type: 'submit', hasOnclick: false }]);
  });

  it('keeps the legacy back link, multipart form and title length', async () => {
    const markup = toString(await renderImportForm(contextFor('importform')));

    expect(markup).toContain(`href="./?muraAction=cArch.list&amp;siteid=${SITE}"`);
    expect(markup).toContain('action="?muraAction=cForm.importform" method="post" enctype="multipart/form-data"');
    expect(markup).toContain('maxlength="255"');
  });

  it('requests its tokens for the formimport context', async () => {
    const ctx = contextFor('importform');

    await renderImportForm(ctx);

    expect(ctx.gateway.calls.map(({ service, method, path, json }) => ({ service, method, path, json }))).toEqual([
      { service: 'identity', method: 'POST', path: '/v1/csrf/tokens', json: { contexts: ['formimport'] } },
    ]);
  });
});

describe('submitImportForm', () => {
  it('relays the upload unchanged and follows the service redirect as legacy location()', async () => {
    const relayed: RecordedRequest[] = [];
    const gateway = fakeGatewayClient({
      [IMPORT_ROUTE]: (request) => {
        relayed.push(request);
        return { status: 200, body: { saved: true, errors: {}, redirect: LIST_REDIRECT } };
      },
    });
    const fields = { title: 'Imported Form', ...CSRF_FIELDS };
    const upload = await multipart(fields, zipFile());

    const result = await submitImportForm(contextFor('importform', { ...fields, formzip: 'form.zip' }, gateway, upload.body));

    expect(result).toEqual({ kind: 'location', location: LIST_LOCATION });
    expect(serviceCalls(gateway)).toEqual([{ service: 'strategies-content', method: 'POST', path: IMPORT_PATH }]);
    const [request] = relayed;
    if (request === undefined) throw new Error('strategies-content received no import');
    expect(request.headers['content-type']).toBe(upload.body.contentType);
    expect(request.bytes.equals(upload.bytes)).toBe(true);
    const form = await relayedForm(request);
    expect([...form.keys()]).toEqual(['title', 'csrf_token', 'csrf_token_expires', 'formzip']);
    expect(Object.fromEntries(Object.keys(fields).map((name) => [name, form.get(name)]))).toEqual(fields);
    const file = form.get('formzip');
    if (!(file instanceof File)) throw new TypeError('formzip was not relayed as a file');
    expect({ name: file.name, type: file.type }).toEqual({ name: 'form.zip', type: 'application/zip' });
    expect(Buffer.compare(new Uint8Array(await file.arrayBuffer()), ZIP)).toBe(0);
  });

  it.each<[string, Fields, string, string]>([
    [
      'a rejected token',
      { title: 'Imported Form', csrf_token: 'STALETOKEN', csrf_token_expires: FIXED_CSRF.expires },
      'alert',
      'Invalid security token. Please try again.',
    ],
    ['an empty title', { title: '', ...CSRF_FIELDS }, 'errormessage', 'Title is required'],
    [
      'an upload without an exported form',
      { title: 'Imported Form', ...CSRF_FIELDS },
      'errormessage',
      'Upload did not contain an exported Masa CMS Form',
    ],
  ])('re-renders the view as legacy shows it for %s', async (_label, fields, key, message) => {
    const gateway = fakeGatewayClient({
      [IMPORT_ROUTE]: { status: 200, body: { saved: false, errors: {}, redirect: null, data: { [key]: message } } },
    });
    const upload = await multipart(fields, zipFile());
    const ctx = contextFor('importform', { ...fields, formzip: 'form.zip' }, gateway, upload.body);

    const markup = rerenderedMarkup(await submitImportForm(ctx));

    expect(markup).toEqual(toString(await renderImportForm(ctx)));
    expect(markup).not.toContain(message);
    expect(serviceCalls(gateway)).toEqual([{ service: 'strategies-content', method: 'POST', path: IMPORT_PATH }]);
  });

  it.each<[string, Fields, () => Promise<ScreenRequestBody | undefined>]>([
    ['no request body', { formzip: 'form.zip' }, () => Promise.resolve(undefined)],
    [
      'an empty form scope',
      { formzip: 'form.zip' },
      () => Promise.resolve({ contentType: '', body: new Blob([]), form: new URLSearchParams() }),
    ],
    [
      'no chosen file',
      { formzip: '' },
      async () => (await multipart(CSRF_FIELDS, new File([], '', { type: 'application/octet-stream' }))).body,
    ],
  ])('re-renders the view without a service call for %s', async (_label, rc, bodyOf) => {
    const gateway = fakeGatewayClient();
    const ctx = contextFor('importform', { title: 'Imported Form', ...CSRF_FIELDS, ...rc }, gateway, await bodyOf());

    const markup = rerenderedMarkup(await submitImportForm(ctx));

    expect(markup).toEqual(toString(await renderImportForm(ctx)));
    expect(serviceCalls(gateway)).toEqual([]);
  });

  it('relays an empty site segment and back link when rc names no site', async () => {
    const gateway = fakeGatewayClient({
      [routeKey('POST', 'strategies-content', '/v1/sites//forms/import')]: {
        status: 200,
        body: { saved: false, errors: {}, redirect: null },
      },
    });
    const fields = { title: 'Imported Form', ...CSRF_FIELDS };
    const upload = await multipart(fields, zipFile());
    const ctx = contextFor('importform', { ...fields, formzip: 'form.zip' }, gateway, upload.body);
    const { siteid: _siteid, ...rc } = ctx.req.rc;

    const markup = rerenderedMarkup(await submitImportForm({ ...ctx, req: { ...ctx.req, rc } }));

    expect(markup).toContain('href="./?muraAction=cArch.list&amp;siteid="');
    expect(serviceCalls(gateway)).toEqual([
      { service: 'strategies-content', method: 'POST', path: '/v1/sites//forms/import' },
    ]);
  });

  it('fails as legacy does when the form scope has no formzip', async () => {
    const gateway = fakeGatewayClient();
    const body: ScreenRequestBody = {
      contentType: 'application/x-www-form-urlencoded',
      body: new Blob(['title=Imported+Form']),
      form: new URLSearchParams({ title: 'Imported Form' }),
    };

    await expect(submitImportForm(contextFor('importform', { title: 'Imported Form' }, gateway, body))).rejects.toEqual(
      new TypeError('Element FORMZIP is undefined in FORM.'),
    );
    expect(serviceCalls(gateway)).toEqual([]);
  });
});
