// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Reporting as a client of the finance and timesheets export reads: what it sends over the wire, the credential it presents and the fields it reads, against each producer's OpenAPI contract. */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasAnyRole, serviceRole, type AuthResult } from '@opt2/platform/auth';
import { createServiceClient, type ServiceClient, type ServiceRequest, type ServiceResponse } from '@opt2/platform/service-kit';
import {
  ContractAssertionError,
  TENANT_A,
  assertRequestMatchesOpenApi,
  assertResponseMatchesOpenApi,
  findOperation,
  testVerifier,
  type OperationMatch,
} from '@opt2/platform/testing';
import { openExportTable, parseDefinitionColumns, type ExportCell, type ExportColumn } from '../../src/domain/sources.js';
import type { ExportDefinitionRow, ExportJobRow } from '../../src/repo/tables.js';
import { OPENAPI, PRODUCER_OPENAPI, SERVICE, SOURCE_PATHS, TEST_AS_OF, testEnv, type ExportProducer } from '../helpers/app.js';
import { SAMPLE_FINANCE_RECORDS, SAMPLE_SHEET_STATUS, definitionFor, jobFor } from '../helpers/fixtures.js';

type Json = Record<string, unknown>;

/** How reporting reads one export source: the producer operation, its paging parameters, the page's row array and the row id. */
interface SourceCase {
  source: 'timesheets.sheets' | 'finance.records';
  producer: ExportProducer;
  operationId: string;
  pageParam: string;
  sizeParam: string;
  rowsField: string;
  /** Definition column exporting the row id held in `idField`. */
  idColumn: string;
  idField: string;
  /** Producer rows in the producer's order, repeated into the stub's table. */
  samples: readonly Json[];
  /** Query values every read carries besides the export scope. */
  fixedQuery: Readonly<Record<string, string>>;
  /** Row values breaking a form the producer pins and reporting passes through unformatted. */
  malformed: Readonly<Record<string, string>>;
}

// The internal System export reads sources.ts calls, not the user-token listSheetStatus and listRecords routes beside them.
const CASES: readonly SourceCase[] = [
  {
    source: 'timesheets.sheets',
    producer: 'timesheets',
    operationId: 'listExportSheetStatus',
    pageParam: 'pageIndex',
    sizeParam: 'itemsPerPage',
    rowsField: 'items',
    idColumn: 'timesheet_id',
    idField: 'timesheetId',
    samples: SAMPLE_SHEET_STATUS,
    fixedQuery: { asOf: TEST_AS_OF },
    malformed: { timesheetId: '7E1A0000-0000-4000-800000000000001', personId: 'not-a-cf-uuid' },
  },
  {
    source: 'finance.records',
    producer: 'finance',
    operationId: 'listExportRecords',
    pageParam: 'page',
    sizeParam: 'pageSize',
    rowsField: 'data',
    idColumn: 'record_id',
    idField: 'record_id',
    samples: SAMPLE_FINANCE_RECORDS,
    fixedQuery: {},
    malformed: { amount: '1250.5', record_id: '7E1A0000-0000-4000-800000000000001' },
  },
];

/** One read as the producer stub received it, with the answer it sent. */
interface WireRead {
  method: string;
  path: string;
  query: Record<string, string | string[]>;
  headers: IncomingHttpHeaders;
  rawHeaders: string[];
  status: number;
  contentType: string;
  body: string;
}

/** A running producer stub: its table, the reads it received and its base URL. */
interface Stub {
  c: SourceCase;
  server: Server;
  url: string;
  rows: readonly Json[];
  reads: WireRead[];
}

/** Names of the page and row fields reporting read from one producer's answers. */
interface FieldReads {
  page: Set<string>;
  row: Set<string>;
}

/** Everything one export source run sent, received and read. */
interface Observed {
  definition: ExportDefinitionRow;
  job: ExportJobRow;
  producerRows: readonly Json[];
  columns: readonly ExportColumn[];
  rows: (readonly ExportCell[])[];
  reads: WireRead[];
  /** What the producer's service transport verified for each read, aligned with `reads`. */
  identities: AuthResult[];
  fields: FieldReads;
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `node` with local `#/…` references followed until a non-reference node; the document's own object, so a mutation edits it. */
function deref(doc: object, node: unknown): unknown {
  let current = node;
  const seen = new Set<string>();
  while (isRecord(current) && typeof current.$ref === 'string' && current.$ref.startsWith('#/') && !seen.has(current.$ref)) {
    seen.add(current.$ref);
    current = current.$ref
      .slice(2)
      .split('/')
      .map((segment) => decodeURIComponent(segment).replace(/~1/g, '/').replace(/~0/g, '~'))
      .reduce<unknown>((parent, segment) => (isRecord(parent) ? parent[segment] : undefined), doc);
  }
  return current;
}

/** Query parameters `match` declares, path-item ones first, references resolved. */
function queryParameters(doc: object, match: OperationMatch): Json[] {
  const paths = (doc as { paths?: unknown }).paths;
  const item = deref(doc, isRecord(paths) ? paths[match.template] : undefined);
  const shared: unknown[] = isRecord(item) && Array.isArray(item.parameters) ? item.parameters : [];
  const own: unknown[] = Array.isArray(match.operation.parameters) ? match.operation.parameters : [];
  return [...shared, ...own].map((parameter) => deref(doc, parameter)).filter((parameter): parameter is Json => isRecord(parameter) && parameter.in === 'query');
}

/** The `maximum` query parameter `name` of `match` declares. */
function declaredMaximum(doc: object, match: OperationMatch, name: string): number {
  const schema = deref(doc, queryParameters(doc, match).find((parameter) => parameter.name === name)?.schema);
  const maximum = isRecord(schema) ? schema.maximum : undefined;
  if (typeof maximum !== 'number') throw new Error(`${match.template} declares no maximum for ${name}`);
  return maximum;
}

/** The 200 `application/json` schema of `match`, references resolved. */
function okSchema(doc: object, match: OperationMatch): Json {
  const ok = deref(doc, match.operation.responses?.['200']);
  const media = isRecord(ok) && isRecord(ok.content) ? ok.content['application/json'] : undefined;
  const schema = deref(doc, isRecord(media) ? media.schema : undefined);
  if (!isRecord(schema)) throw new Error(`${match.template} declares no 200 application/json schema`);
  return schema;
}

/** `schema` and every `allOf` member under it, references resolved: the objects whose `properties` an instance may carry. */
function schemaParts(doc: object, schema: Json): Json[] {
  const members = Array.isArray(schema.allOf) ? schema.allOf.map((member) => deref(doc, member)).filter(isRecord) : [];
  return [schema, ...members.flatMap((member) => schemaParts(doc, member))];
}

/** Property names `schema` declares, its `allOf` members' included. */
function declaredProperties(doc: object, schema: Json): string[] {
  return schemaParts(doc, schema).flatMap((part) => (isRecord(part.properties) ? Object.keys(part.properties) : []));
}

/** The item schema of page array property `rowsField`. */
function rowSchema(doc: object, page: Json, rowsField: string): Json {
  const array = schemaParts(doc, page)
    .map((part) => (isRecord(part.properties) ? deref(doc, part.properties[rowsField]) : undefined))
    .find(isRecord);
  const items = deref(doc, array?.items);
  if (!isRecord(items)) throw new Error(`the page declares no ${rowsField} item schema`);
  return items;
}

/** The CF-format id of ordinal `n`. */
function cfId(n: number): string {
  return `${n.toString(16).toUpperCase().padStart(8, '0')}-0000-4000-8000000000000000`;
}

/** Each sample repeated in a block, keeping the producer's order, until the table outgrows one page of `maxPageSize`; ids are fresh and ascending. */
function producerTable(c: SourceCase, maxPageSize: number): Json[] {
  const copies = Math.ceil((maxPageSize + 1) / c.samples.length);
  return c.samples.flatMap((sample, s) => Array.from({ length: copies }, (_, i) => ({ ...sample, [c.idField]: cfId(s * copies + i + 1) })));
}

/** A loopback stand-in of `c`'s producer answering its export read path with `rows` in the pages each read asks for, recording every read. */
async function startProducer(c: SourceCase, rows: readonly Json[]): Promise<Stub> {
  const reads: WireRead[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://loopback');
    const query: Record<string, string | string[]> = {};
    for (const [name, value] of url.searchParams) {
      const sent = query[name];
      query[name] = sent === undefined ? value : [sent, value].flat();
    }
    const page = Number(url.searchParams.get(c.pageParam));
    const size = Number(url.searchParams.get(c.sizeParam));
    const status = req.method === 'GET' && url.pathname === SOURCE_PATHS[c.producer] ? 200 : 404;
    const body = status === 200 ? JSON.stringify({ [c.rowsField]: rows.slice((page - 1) * size, page * size), total: rows.length }) : '';
    const contentType = 'application/json';
    reads.push({ method: req.method ?? '', path: url.pathname, query, headers: req.headers, rawHeaders: req.rawHeaders, status, contentType, body });
    res.writeHead(status, { 'content-type': contentType }).end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { c, server, url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, rows, reads };
}

/** `target` behind a proxy adding the name of every string-keyed field read to `into`. */
function recorded(target: Json, into: Set<string>): Json {
  return new Proxy(target, {
    get(object, key, receiver) {
      // Promise resolution probes each returned page for `then`; that read is the runtime's, not reporting's.
      if (typeof key === 'string' && key !== 'then') into.add(key);
      return Reflect.get(object, key, receiver) as unknown;
    },
  });
}

/** `inner` with every JSON page it returns proxied, so the page and row fields read are recorded per called service in `fields`. */
function fieldRecording(inner: ServiceClient, fields: Map<string, FieldReads>): ServiceClient {
  return {
    async request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
      const res = await inner.request<T>(req);
      const reads = fields.get(req.service) ?? { page: new Set<string>(), row: new Set<string>() };
      fields.set(req.service, reads);
      const body: unknown = res.body;
      if (!isRecord(body)) return res;
      const page = Object.fromEntries(
        Object.entries(body).map(([name, value]) => [name, Array.isArray(value) ? value.map((row) => (isRecord(row) ? recorded(row, reads.row) : row)) : value]),
      );
      return { ...res, body: recorded(page, reads.page) as T };
    },
    close: () => inner.close(),
  };
}

function thrownBy(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** The operation of `doc` serving the reads, each a GET of its literal path, which must be `c.operationId`. */
function checkOperation(doc: object, c: SourceCase, o: Observed): OperationMatch {
  const match = findOperation(doc, 'GET', o.reads[0]?.path ?? SOURCE_PATHS[c.producer]);
  for (const read of o.reads) expect(`${read.method} ${read.path}`).toBe(`GET ${match.template}`);
  expect(match.operation.operationId, `${match.template} operationId`).toBe(c.operationId);
  return match;
}

/** Asserts `match` is a role-declared service route whose roles admit, for every read, what the producer's transport verified, and no user. */
function checkAdmission(match: OperationMatch, o: Observed): void {
  const { template, operation } = match;
  expect(operation['x-opt2-transport'], `${template} transport`).toBe('service');
  expect(operation['x-opt2-public'], `${template} must declare roles, not x-opt2-public`).not.toBe(true);
  const requires = Array.isArray(operation['x-opt2-requires']) ? operation['x-opt2-requires'].map(String) : [];
  for (const identity of o.identities) {
    const roles = identity.service?.roles ?? [];
    expect(identity.user, `${template} read carries a user`).toBeUndefined();
    expect(hasAnyRole(roles, requires), `${template} requires ${requires.join(' | ')}; reporting presents ${roles.join(', ')}`).toBe(true);
  }
}

/** Validates every read's path, query and headers against its operation in `doc`. */
function checkQuery(doc: object, o: Observed): void {
  for (const read of o.reads) assertRequestMatchesOpenApi(doc, { method: read.method, path: read.path, query: read.query, headers: read.headers });
}

/** Asserts every page and row field reporting read is a property the 200 schema of `match` declares. */
function checkFields(doc: object, c: SourceCase, match: OperationMatch, o: Observed): void {
  const page = okSchema(doc, match);
  const pageFields = declaredProperties(doc, page);
  for (const field of o.fields.page) expect(pageFields, `page field ${field}`).toContain(field);
  const rowFields = declaredProperties(doc, rowSchema(doc, page, c.rowsField));
  for (const field of o.fields.row) expect(rowFields, `row field ${field}`).toContain(field);
}

/** Validates every answer the stub sent against its operation's declared response in `doc`. */
function checkPages(doc: object, o: Observed): void {
  for (const read of o.reads) {
    assertResponseMatchesOpenApi(doc, { method: read.method, path: read.path, status: read.status, contentType: read.contentType, body: read.body });
  }
}

/** Every check of `c`'s observed reads against producer contract `doc`. */
function assertReadsMatch(doc: object, c: SourceCase, o: Observed): void {
  const match = checkOperation(doc, c, o);
  checkAdmission(match, o);
  checkQuery(doc, o);
  checkFields(doc, c, match, o);
  checkPages(doc, o);
}

type Mutation = [string, (doc: object, match: OperationMatch, c: SourceCase) => void, RegExp];

/** Changes to a producer's contract that each must break reporting's export read, with the finding each produces. */
const MUTATIONS: Mutation[] = [
  [
    'the export read moved to another path',
    (doc, { template }) => {
      const paths = (doc as { paths: Json }).paths;
      paths[template.replace('/v1/', '/v2/')] = paths[template];
      delete paths[template];
    },
    /no operation for GET/,
  ],
  [
    'a role reporting does not carry',
    (_doc, { operation }) => {
      operation['x-opt2-requires'] = [serviceRole('people')];
    },
    /requires service:people/,
  ],
  [
    'a public route instead of declared roles',
    (_doc, { operation }) => {
      delete operation['x-opt2-requires'];
      operation['x-opt2-public'] = true;
    },
    /must declare roles, not x-opt2-public/,
  ],
  [
    'another transport',
    (_doc, { operation }) => {
      operation['x-opt2-transport'] = 'cloud-tasks';
    },
    /transport: expected 'cloud-tasks' to be 'service'/,
  ],
  [
    'a page-size maximum below the size reporting asks for',
    (doc, match, c) => {
      const schema = deref(doc, queryParameters(doc, match).find((parameter) => parameter.name === c.sizeParam)?.schema);
      if (isRecord(schema)) schema.maximum = 100;
    },
    /must be <= 100/,
  ],
  [
    'a new required query parameter',
    (_doc, { operation }) => {
      const parameters: unknown[] = Array.isArray(operation.parameters) ? operation.parameters : [];
      operation.parameters = [...parameters, { name: 'tenantId', in: 'query', required: true, schema: { type: 'string' } }];
    },
    /query\/tenantId is required/,
  ],
  [
    'the page row array renamed',
    (doc, match, c) => {
      for (const part of schemaParts(doc, okSchema(doc, match))) {
        if (isRecord(part.properties) && c.rowsField in part.properties) {
          part.properties.rows = part.properties[c.rowsField];
          delete part.properties[c.rowsField];
        }
      }
    },
    /page field (items|data)/,
  ],
];

const observed = new Map<SourceCase['source'], Observed>();
/** Page and row fields read, keyed by every service the export reads called. */
const fields = new Map<string, FieldReads>();
const stubs: Stub[] = [];
let client: ServiceClient | undefined;

/** The observation of `c`'s run. */
function seen(c: SourceCase): Observed {
  const o = observed.get(c.source);
  if (o === undefined) throw new Error(`${c.source} was not observed`);
  return o;
}

/** Runs `stub`'s source for a running tenant-a job through `deps.client`, reads every row, and verifies each read as its producer would. */
async function observe(stub: Stub, deps: { client: ServiceClient }): Promise<Observed> {
  const { c } = stub;
  const definition = definitionFor(TENANT_A, c.source);
  const job = jobFor(definition, { format: 'csv', state: 'running' });
  const table = await openExportTable(deps, { job, definition, asOf: TEST_AS_OF });
  const rows: (readonly ExportCell[])[] = [];
  for await (const row of table.rows) rows.push(row);
  const transport = testVerifier(c.producer).transports.service;
  const identities = await Promise.all(
    stub.reads.map((read) => transport.authenticate({ headers: read.headers, rawHeaders: read.rawHeaders, path: read.path }, { optional: false })),
  );
  const read = fields.get(c.producer) ?? { page: new Set<string>(), row: new Set<string>() };
  return { definition, job, producerRows: stub.rows, columns: table.columns, rows, reads: stub.reads, identities, fields: read };
}

beforeAll(async () => {
  for (const c of CASES) {
    const doc = PRODUCER_OPENAPI[c.producer];
    const rows = producerTable(c, declaredMaximum(doc, findOperation(doc, 'GET', SOURCE_PATHS[c.producer]), c.sizeParam));
    stubs.push(await startProducer(c, rows));
  }
  // The env and invocation credential buildTestApp gives the app's own client, with both producers moved onto the stubs.
  const env = testEnv(tmpdir());
  const recording = fieldRecording(
    createServiceClient({
      serviceUrls: { ...env.OPT2_SERVICE_URLS, ...Object.fromEntries(stubs.map((stub) => [stub.c.producer, stub.url])) },
      self: env.OPT2_SERVICE_NAME,
      credentials: testVerifier(SERVICE).invocationMinter,
    }),
    fields,
  );
  client = recording;
  for (const stub of stubs) observed.set(stub.c.source, await observe(stub, { client: recording }));
});

afterAll(async () => {
  await client?.close();
  await Promise.all(stubs.map(({ server }) => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))));
});

describe.each(CASES)('$source through $producer $operationId', (c) => {
  const doc = PRODUCER_OPENAPI[c.producer];
  const match = (): OperationMatch => findOperation(doc, 'GET', SOURCE_PATHS[c.producer]);

  it('reads the tenant through GETs of the literal path of the producer operation', () => {
    checkOperation(doc, c, seen(c));
  });

  it('reads every page from page 1 in one page size, across more than one page', () => {
    const { reads, producerRows } = seen(c);
    const sizes = [...new Set(reads.map((read) => read.query[c.sizeParam]))];
    expect(sizes).toHaveLength(1);
    const pages = Math.ceil(producerRows.length / Number(sizes[0]));
    expect(pages).toBeGreaterThan(1);
    expect(reads.map((read) => read.query[c.pageParam])).toEqual(Array.from({ length: pages }, (_, i) => String(i + 1)));
  });

  it('sends only query parameters the operation declares, each valid against its schema', () => {
    checkQuery(doc, seen(c));
  });

  it('scopes every read to the running job, its site and its claim, with the business date where the operation takes one', () => {
    const { reads, job } = seen(c);
    for (const read of reads) expect(read.query).toMatchObject({ exportId: job.job_id, siteId: job.siteid, claim: job.row_version, ...c.fixedQuery });
  });

  it("presents reporting's invocation credential and no user token, which the producer's service transport admits", () => {
    const o = seen(c);
    expect(o.reads.map((read) => read.headers.authorization)).toEqual(o.reads.map(() => undefined));
    for (const identity of o.identities) expect(identity.service).toMatchObject({ name: SERVICE, roles: expect.arrayContaining([serviceRole(SERVICE)]) });
    checkAdmission(match(), o);
  });

  it('reads only page and row fields the 200 schema declares, paging by the row array and its total', () => {
    const o = seen(c);
    expect([...o.fields.page]).toEqual(expect.arrayContaining([c.rowsField, 'total']));
    expect(o.fields.row.size).toBeGreaterThan(0);
    checkFields(doc, c, match(), o);
  });

  it("exports one row per producer row under the definition's columns, none lost or repeated", () => {
    const o = seen(c);
    expect(o.columns).toEqual(parseDefinitionColumns(o.definition.columns));
    const at = o.columns.findIndex((column) => column.field === c.idColumn);
    expect(at, `${c.idColumn} column`).toBeGreaterThanOrEqual(0);
    expect(o.rows.map((row) => row[at]).sort()).toEqual(o.producerRows.map((row) => String(row[c.idField])).sort());
  });

  it('answers each read with a page of sample rows that validates against the 200 schema', () => {
    const o = seen(c);
    expect(o.reads.map((read) => read.status)).toEqual(o.reads.map(() => 200));
    checkPages(doc, o);
  });

  it('relies on the producer contract to pin the money and CF id forms it passes through unformatted', () => {
    const [read] = seen(c).reads;
    if (read === undefined) throw new Error(`${c.source} made no read`);
    for (const [field, value] of Object.entries(c.malformed)) {
      const body = JSON.parse(read.body) as Json;
      const rows = body[c.rowsField] as Json[];
      rows[0] = { ...rows[0], [field]: value };
      const error = thrownBy(() =>
        assertResponseMatchesOpenApi(doc, { method: read.method, path: read.path, status: read.status, contentType: read.contentType, body }),
      );
      expect(error, field).toBeInstanceOf(ContractAssertionError);
      expect((error as ContractAssertionError).errors.map((violation) => violation.instancePath), field).toContain(`/${c.rowsField}/0/${field}`);
    }
  });

  it.each(MUTATIONS)('fails against a producer contract with %s', (_change, mutate, finding) => {
    const clone = structuredClone(doc);
    mutate(clone, findOperation(clone, 'GET', SOURCE_PATHS[c.producer]), c);
    expect(() => assertReadsMatch(clone, c, seen(c))).toThrow(finding);
  });

  it('fails against a producer contract renaming any query parameter it sends', () => {
    const sent = Object.keys(seen(c).reads[0]?.query ?? {});
    expect(sent.length).toBeGreaterThan(0);
    for (const name of sent) {
      const clone = structuredClone(doc);
      for (const parameter of queryParameters(clone, findOperation(clone, 'GET', SOURCE_PATHS[c.producer]))) {
        if (parameter.name === name) parameter.name = `${name}Renamed`;
      }
      expect(() => assertReadsMatch(clone, c, seen(c)), name).toThrow(`query/${name} is not a declared query parameter`);
    }
  });

  it('fails against a producer contract dropping any row field it reads', () => {
    const read = [...seen(c).fields.row];
    expect(read.length).toBeGreaterThan(0);
    for (const field of read) {
      const clone = structuredClone(doc);
      for (const part of schemaParts(clone, rowSchema(clone, okSchema(clone, findOperation(clone, 'GET', SOURCE_PATHS[c.producer])), c.rowsField))) {
        if (isRecord(part.properties)) delete part.properties[field];
        if (Array.isArray(part.required)) part.required = part.required.filter((name) => name !== field);
      }
      expect(() => assertReadsMatch(clone, c, seen(c)), field).toThrow(`row field ${field}`);
    }
  });
});

describe('declared call graph', () => {
  it('reaches only finance and timesheets for export sources, each declared in reporting x-opt2-calls', () => {
    const reached = [...fields.keys()].sort();
    expect(reached).toEqual(['finance', 'timesheets']);
    // A containment, not equality: reporting also calls identity, for the CSRF ledger of its writes.
    expect((OPENAPI as Json)['x-opt2-calls']).toEqual(expect.arrayContaining(reached));
  });
});

