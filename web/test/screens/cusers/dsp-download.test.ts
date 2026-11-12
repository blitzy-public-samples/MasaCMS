// relayUsersCsv against `cusers/inc/dsp_download.cfm` and the people and identity users CSV operations.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GatewayClient, GatewayResponse } from '@/lib/gateway-client';
import { downloadResponse, HTML_CONTENT_TYPE } from '@/lib/responses';
import { relayUsersCsv, type UsersCsvSource } from '@/screens/cusers/inc/dsp_download';
import type { RawBody } from '@/screens/registry';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeReply } from '../../helpers/fake-gateway';

const DISPOSITION = 'attachment;filename=users.csv';
const GROUP_ID = 'C2000000-0000-0000-0000000000000001';
// Legacy users CSV shape: non-numeric cells quoted, each value with a trailing space, embedded commas and quotes kept
// as legacy emits them, LF row ends, and multi-byte names.
const CSV_BYTES = Buffer.from(
  '"USERID","FNAME","LNAME","COMPANY","INACTIVE"\n' +
    '"C1000000-0000-0000-0000000000000001","Zoë ","Ñúñez-Müller ","Acme, Inc. ",0 \n' +
    '"C1000000-0000-0000-0000000000000002","李 ",""Quoted" Name ","Line\nBreak, Ltd. ",1 \n',
  'utf8',
);

type Fetch = (gateway: GatewayClient) => Promise<GatewayResponse<Buffer>>;

const DOWNLOADS: Array<[string, string, Fetch]> = [
  [
    'cusers.download',
    routeKey('GET', 'people', '/v1/users/download'),
    (g) => g.people.raw('get', '/v1/users/download', { query: { siteid: 'default', ispublic: '0' } }),
  ],
  [
    'cusers.advancedSearchToCSV',
    routeKey('GET', 'people', '/v1/users/advanced-search.csv'),
    (g) => g.people.raw('get', '/v1/users/advanced-search.csv', { query: { siteid: 'default', ispublic: '1' } }),
  ],
  [
    'cusers.downloadGroupMembers',
    routeKey('GET', 'identity', `/v1/groups/${GROUP_ID}/members.csv`),
    (g) => g.identity.raw('get', '/v1/groups/{groupId}/members.csv', { params: { groupId: GROUP_ID } }),
  ],
];

const CONTENT_TYPES = ['text/csv', 'text/csv; charset=UTF-8'];

const CASES = DOWNLOADS.flatMap(([action, route, fetch]) =>
  CONTENT_TYPES.map((contentType) => [action, contentType, route, fetch] as const),
);

/** The service answer of `route` through the production gateway client. */
async function relayed(route: string, fetch: Fetch, reply: FakeReply): Promise<RawBody> {
  return relayUsersCsv(await fetch(fakeGatewayClient({ [route]: reply })));
}

/** The relayed body's bytes, asserting they were never decoded. */
function bytesOf(raw: RawBody): Uint8Array {
  if (!(raw.body instanceof Uint8Array)) throw new TypeError('Expected the relayed bytes');
  return raw.body;
}

/** A gateway answer with `headers` and the CSV bytes. */
function answer(headers: Record<string, string | string[]>, setCookies: string[] = []): GatewayResponse<Buffer> {
  return { status: 200, ok: true, headers, body: CSV_BYTES, setCookies };
}

describe('relayUsersCsv', () => {
  let restoreEnv: () => void;

  beforeEach(() => {
    restoreEnv = useTestEnv();
  });

  afterEach(() => {
    restoreEnv();
  });

  it.each(CASES)('relays %s answered as %s byte for byte', async (_action, contentType, route, fetch) => {
    const raw = await relayed(route, fetch, {
      status: 200,
      headers: { 'Content-Type': contentType, 'Content-Disposition': DISPOSITION },
      body: CSV_BYTES,
    });

    expect(raw.status).toBe(200);
    expect(raw.contentType).toBe(contentType);
    expect(raw.headers).toEqual({ 'content-disposition': DISPOSITION });
    expect(raw).not.toHaveProperty('setCookies');
    expect(Buffer.compare(bytesOf(raw), CSV_BYTES)).toBe(0);
  });

  it('keeps the bytes and both headers through the download response the handler builds', async () => {
    const raw = relayUsersCsv(
      answer({ 'content-type': 'text/csv; charset=UTF-8', 'content-disposition': DISPOSITION }),
    );

    const res = downloadResponse({
      status: raw.status ?? 200,
      headers: { 'content-type': raw.contentType, ...raw.headers },
      body: bytesOf(raw),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=UTF-8');
    expect(res.headers.get('content-disposition')).toBe(DISPOSITION);
    expect(Buffer.compare(Buffer.from(await res.arrayBuffer()), CSV_BYTES)).toBe(0);
  });

  it.each<[number, string]>([
    [400, '{"error":"invalid siteid"}'],
    [404, ''],
  ])('relays a service %i with its own content type and body', async (status, body) => {
    const [, route, fetch] = DOWNLOADS[0]!;
    const raw = await relayed(route, fetch, {
      status,
      headers: { 'content-type': 'application/json;charset=utf-8' },
      body,
    });

    expect(raw.status).toBe(status);
    expect(raw.contentType).toBe('application/json;charset=utf-8');
    expect(raw).not.toHaveProperty('headers');
    expect(Buffer.from(bytesOf(raw)).toString('utf8')).toBe(body);
  });

  it('labels an answer without a content type as ACF HTML', () => {
    const raw = relayUsersCsv(answer({ 'content-disposition': DISPOSITION }));

    expect(raw.contentType).toBe(HTML_CONTENT_TYPE);
    expect(raw.headers).toEqual({ 'content-disposition': DISPOSITION });
  });

  it('takes the first of repeated headers and relays Set-Cookie values in order', () => {
    const raw = relayUsersCsv(
      answer({ 'content-type': ['text/csv', 'text/plain'], 'content-disposition': [DISPOSITION, 'inline'] }, [
        'a=1; Path=/',
        'b=2; Path=/',
      ]),
    );

    expect(raw.contentType).toBe('text/csv');
    expect(raw.headers).toEqual({ 'content-disposition': DISPOSITION });
    expect(raw.setCookies).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    expect(raw.body).toBe(CSV_BYTES);
  });
});

describe('UsersCsvSource', () => {
  it.each<UsersCsvSource>([
    { source: 'group-members', groupId: GROUP_ID },
    { source: 'advanced-search', siteid: 'default', ispublic: 0 },
    { source: 'advanced-search', siteid: 'tenant-a', ispublic: '1' },
  ])('survives a JSON round trip: %o', (source) => {
    expect(JSON.parse(JSON.stringify(source))).toEqual(source);
  });
});
