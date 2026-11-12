// cform.importform against cform.cfc importform(), importform.cfm and the strategies-content importForm contract.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createCsrfRenderer } from '@/lib/csrf';
import { GatewayDenialError, GatewayUnavailableError } from '@/lib/gateway-client';
import { isSafeHtml, toString } from '@/lib/html';
import { receiveRequestBody, type ReceivedBody } from '@/lib/request-body';
import { rbFor } from '@/lib/resource-bundles/rb';
import { renderImportForm, submitImportForm } from '@/screens/cform/importform';
import type { ScreenContext, SubmitResult } from '@/screens/registry';
import { adminS2Request } from '../../helpers/admin-request';
import { fragmentModel, normaliseAdminUrl } from '../../helpers/dom-model';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';

type Fields = Readonly<Record<string, string>>;

const CSRF_ROUTE = routeKey('POST', 'identity', '/v1/csrf/tokens');
const IMPORT_PATH = '/v1/sites/default/forms/import';
const IMPORT_ROUTE = routeKey('POST', 'strategies-content', IMPORT_PATH);
const EXPIRES = '261112191044236';
const FORMS_MODULE = '00000000000000000000000000000000004';
// The legacy view body for siteid `default`, captured from legacy with its tokens replaced by the fake's pair.
const LEGACY_BODY = readFileSync(new URL('../../fixtures/strategies-content/importform.html', import.meta.url), 'utf8');
const ZIP_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x0d, 0x0a, 0x2d, 0x2d]);
const POSTED_CSRF: Fields = { csrf_token: 'A'.repeat(64), csrf_token_expires: EXPIRES };
const LIST_REDIRECT = {
  circuit: 'cArch',
  action: 'list',
  params: [
    ['siteid', 'default'],
    ['topid', FORMS_MODULE],
    ['moduleid', FORMS_MODULE],
    ['activeTab', '0'],
  ],
};
const LEGACY_LOCATION = `?muraAction=cArch.list&siteid=default&topid=${FORMS_MODULE}&moduleid=${FORMS_MODULE}&activeTab=0`;

const received: ReceivedBody[] = [];

afterEach(async () => {
  await Promise.all(received.splice(0).map((body) => body.dispose?.()));
});

/** Identity issuing `T-<context>` / EXPIRES for every requested context, plus `routes`. */
function gatewayWith(routes: Record<string, FakeReply> = {}): FakeGatewayClient {
  return fakeGatewayClient({
    [CSRF_ROUTE]: (request) => ({
      status: 200,
      body: {
        tokens: (request.json as { contexts: string[] }).contexts.map((context) => ({
          context,
          csrf_token: `T-${context}`,
          csrf_token_expires: EXPIRES,
        })),
      },
    }),
    ...routes,
  });
}

function contextFor(rc: Fields, gateway: FakeGatewayClient, body?: ReceivedBody): ScreenContext {
  return {
    req: adminS2Request({ circuit: 'cform', item: 'importform', rc: { siteid: 'default', ...rc } }),
    gateway,
    csrf: createCsrfRenderer(gateway),
    rb: rbFor('en_US'),
    hooks: { secondaryMenus: {} },
    now: new Date('2026-06-30T12:00:00Z'),
    body: body?.body,
  };
}

/** A multipart body as web receives it, with its bytes and content type as the browser sent them. */
async function multipart(
  fields: Fields,
  file?: File,
): Promise<{ body: ReceivedBody; bytes: Buffer; contentType: string }> {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  form.append('formzip', file ?? new File([], '', { type: 'application/octet-stream' }));
  const request = new Request('http://web.test/admin-actions/cform/importform', { method: 'POST', body: form });
  const bytes = Buffer.from(await request.clone().arrayBuffer());
  const contentType = request.headers.get('content-type') ?? '';
  const body = await receiveRequestBody(request);
  received.push(body);
  return { body, bytes, contentType };
}

/** The service calls, without identity's token issuance. */
const serviceCalls = (gateway: FakeGatewayClient) => gateway.calls.filter((call) => call.service !== 'identity');

/** The markup of a re-render outcome. */
function renderedMarkup(result: SubmitResult): string {
  if (result.kind !== 'render') throw new TypeError(`Expected a re-render, got ${result.kind}`);
  expect(result.status).toBeUndefined();
  return toString(result.view.body);
}

describe('renderImportForm', () => {
  it('emits the legacy view body exactly, tokens issued for formimport', async () => {
    const gateway = gatewayWith();

    const markup = await renderImportForm(contextFor({}, gateway));

    expect(isSafeHtml(markup)).toBe(true);
    expect(toString(markup)).toBe(LEGACY_BODY);
    expect(gateway.calls).toEqual([
      expect.objectContaining({ service: 'identity', path: '/v1/csrf/tokens', json: { contexts: ['formimport'] } }),
    ]);
  });

  it('models the heading, back link, multipart form, fields and Import button', async () => {
    const markup = toString(await renderImportForm(contextFor({}, gatewayWith())));
    const model = fragmentModel(markup);

    expect(model.headings).toEqual(['Import Form', 'Form Builder']);
    expect(model.links).toEqual([
      { href: normaliseAdminUrl('./?muraAction=cArch.list&siteid=default'), text: 'Return to Content Manager' },
    ]);
    expect(markup).toContain(
      '<form novalidate="novalidate" action="?muraAction=cForm.importform" method="post" enctype="multipart/form-data">',
    );
    expect(model.labels).toEqual(['Title', 'Form To Import (Zip File)']);
    expect(model.controls.map(({ name, type, value }) => ({ name, type, value }))).toEqual([
      { name: 'csrf_token', type: 'hidden', value: 'T-formimport' },
      { name: 'csrf_token_expires', type: 'hidden', value: EXPIRES },
      { name: 'title', type: 'text', value: '' },
      { name: 'formzip', type: 'file', value: '' },
    ]);
    expect(model.buttons).toEqual([{ text: 'Import', type: 'submit', hasOnclick: false }]);
  });

  it('URL-encodes rc.siteid in the back link as esapiEncode does', async () => {
    const markup = toString(await renderImportForm(contextFor({ siteid: 'tenant a&b' }, gatewayWith())));

    expect(markup).toContain('href="./?muraAction=cArch.list&amp;siteid=tenant+a%26b">');
  });
});

describe('submitImportForm', () => {
  // A url `formzip` reaches rc without filling the form scope, which alone lets legacy import.
  it.each<[string, Fields, () => Promise<ReceivedBody | undefined>]>([
    ['no request body', { formzip: 'form.zip' }, async () => undefined],
    [
      'an empty form scope',
      { formzip: 'form.zip' },
      () => receiveRequestBody(new Request('http://web.test/', { method: 'POST', body: '' })),
    ],
    ['no chosen file', { formzip: '' }, async () => (await multipart({ title: 'Contact', ...POSTED_CSRF })).body],
  ])('re-renders the view without a service call for %s', async (_label, rc, bodyOf) => {
    const gateway = gatewayWith();
    const body = await bodyOf();

    const result = await submitImportForm(contextFor({ title: 'Contact', ...rc, ...POSTED_CSRF }, gateway, body));

    expect(renderedMarkup(result)).toBe(LEGACY_BODY);
    expect(serviceCalls(gateway)).toEqual([]);
  });

  it('fails as legacy does when the form scope has no formzip', async () => {
    const gateway = gatewayWith();
    const body = await receiveRequestBody(
      new Request('http://web.test/', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'title=Contact',
      }),
    );

    await expect(submitImportForm(contextFor({ title: 'Contact' }, gateway, body))).rejects.toThrow(
      'Element FORMZIP is undefined in FORM.',
    );
    expect(serviceCalls(gateway)).toEqual([]);
  });

  it('relays the multipart body byte-for-byte and follows the service redirect as legacy location()', async () => {
    let relayed: { bytes: Buffer; contentType?: string } | undefined;
    const gateway = gatewayWith();
    gateway.setRoute(IMPORT_ROUTE, (request) => {
      relayed = { bytes: request.bytes, contentType: request.headers['content-type'] };
      return { status: 200, body: { saved: true, errors: {}, redirect: LIST_REDIRECT } };
    });
    const zip = new File([ZIP_BYTES], 'contact-form.zip', { type: 'application/zip' });
    const upload = await multipart({ title: 'Contact', ...POSTED_CSRF }, zip);
    const rc = { title: 'Contact', formzip: 'contact-form.zip', ...POSTED_CSRF };

    const result = await submitImportForm(contextFor(rc, gateway, upload.body));

    expect(result).toEqual({ kind: 'location', location: LEGACY_LOCATION });
    expect(serviceCalls(gateway)).toEqual([
      expect.objectContaining({ service: 'strategies-content', method: 'POST', path: IMPORT_PATH }),
    ]);
    expect(relayed?.contentType).toBe(upload.contentType);
    expect(relayed?.bytes.equals(upload.bytes)).toBe(true);
    const text = upload.bytes.toString('latin1');
    for (const [name, value] of Object.entries({ title: 'Contact', ...POSTED_CSRF })) {
      expect(text).toContain(`name="${name}"\r\n\r\n${value}\r\n`);
    }
    expect(text).toContain('name="formzip"; filename="contact-form.zip"\r\nContent-Type: application/zip');
    expect(relayed?.bytes.includes(ZIP_BYTES)).toBe(true);
  });

  it('keeps a redirect parameter unencoded, as the legacy location is', async () => {
    const gateway = gatewayWith({
      [routeKey('POST', 'strategies-content', '/v1/sites/tenant-a/forms/import')]: {
        status: 200,
        body: { saved: true, errors: {}, redirect: { ...LIST_REDIRECT, params: [['siteid', 'tenant a&b']] } },
      },
    });
    const zip = new File([ZIP_BYTES], 'form.zip', { type: 'application/zip' });
    const upload = await multipart({ title: 'Contact' }, zip);

    const result = await submitImportForm(
      contextFor({ siteid: 'tenant-a', title: 'Contact', formzip: 'form.zip' }, gateway, upload.body),
    );

    expect(result).toEqual({ kind: 'location', location: '?muraAction=cArch.list&siteid=tenant a&b' });
  });

  it.each<[string, Readonly<Record<string, string>>]>([
    ['a rejected token or empty title', {}],
    ['an upload without an exported form', { message: 'Upload did not contain an exported Masa CMS Form' }],
  ])('re-renders the view when the service names no redirect for %s', async (_label, errors) => {
    const gateway = gatewayWith({ [IMPORT_ROUTE]: { status: 200, body: { saved: false, errors, redirect: null } } });
    const upload = await multipart({ title: '' }, new File([ZIP_BYTES], 'form.zip', { type: 'application/zip' }));

    const result = await submitImportForm(contextFor({ title: '', formzip: 'form.zip' }, gateway, upload.body));

    expect(renderedMarkup(result)).toBe(LEGACY_BODY);
  });

  it.each<[string, FakeReply | undefined, (error: unknown) => void]>([
    [
      'a 400 answer',
      { status: 400, body: { error: { type: 'badRequest' } } },
      (error) => {
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(GatewayDenialError);
        expect(error).toMatchObject({ message: 'importForm answered HTTP 400' });
      },
    ],
    [
      'a 403 answer',
      { status: 403, body: {} },
      (error) => expect(error).toMatchObject({ name: 'GatewayDenialError', status: 403, operation: 'importForm' }),
    ],
    ['a 503 answer', { status: 503, body: '' }, (error) => expect(error).toBeInstanceOf(GatewayUnavailableError)],
    ['an unreachable gateway', undefined, (error) => expect(error).toBeInstanceOf(GatewayUnavailableError)],
  ])('propagates %s', async (_label, reply, check) => {
    const gateway = gatewayWith(reply === undefined ? {} : { [IMPORT_ROUTE]: reply });
    if (reply === undefined) gateway.failWith();
    const upload = await multipart({ title: 'Contact' }, new File([ZIP_BYTES], 'form.zip', { type: 'application/zip' }));

    const error = await submitImportForm(contextFor({ title: 'Contact', formzip: 'form.zip' }, gateway, upload.body)).catch(
      (caught: unknown) => caught,
    );

    check(error);
  });
});
