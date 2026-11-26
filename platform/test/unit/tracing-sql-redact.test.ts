import { SpanKind, SpanStatusCode, TraceFlags, type Attributes, type AttributeValue } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { afterEach, describe, expect, it } from 'vitest';
import { REDACTED } from '../../src/logging/redact.js';
import { RedactingSpanExporter } from '../../src/tracing/redact.js';
import {
  flushTracing,
  MemorySpanExporter,
  shutdownTracing,
  startSpan,
  startTracing,
  type ReadableSpan,
} from '../../src/tracing/index.js';

/** Synthetic sentinels assembled at run time, so no literal personal data appears in source. */
const PHONE = ['202', '555', '0147'].join('');
const PERSON = ['Synthetic', 'Ada', 'Lovelace'].join(' ');
const WORD = ['sql', 'sentinel', 'text'].join('-');
const SENTINELS = [PHONE, PERSON, WORD, 'Lovelace'];
const PII_SQL = `SELECT ${PHONE}::bigint AS phone, '${WORD}' AS str /* customer ${PERSON} */`;
const PII_SQL_MASKED = `SELECT ${REDACTED}::bigint AS phone, '${REDACTED}' AS str /* ${REDACTED} */`;
const DB_SPAN_NAME = 'pg.query:SELECT masa_services_c10';

/** Finished database client span carrying `attributes`. */
function readable(attributes: Attributes, name = DB_SPAN_NAME): ReadableSpan {
  const spanContext = { traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7', traceFlags: TraceFlags.SAMPLED };
  return {
    name,
    kind: SpanKind.CLIENT,
    spanContext: () => spanContext,
    parentSpanContext: { traceId: spanContext.traceId, spanId: 'b7ad6b7169203331', traceFlags: TraceFlags.SAMPLED },
    startTime: [1_700_000_000, 100],
    endTime: [1_700_000_001, 250],
    duration: [1, 150],
    ended: true,
    status: { code: SpanStatusCode.UNSET },
    attributes,
    links: [],
    events: [],
    resource: resourceFromAttributes({ 'service.name': 'tracing-sql-redact-c10' }),
    instrumentationScope: { name: '@opentelemetry/instrumentation-pg', version: '0.77.0' },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}

/** The copy of `span` a {@link RedactingSpanExporter} hands its delegate. */
function redact(span: ReadableSpan): ReadableSpan {
  const memory = new MemorySpanExporter();
  new RedactingSpanExporter(memory).export([span], () => undefined);
  const [copy] = memory.getFinishedSpans();
  if (!copy) throw new Error('no span exported');
  return copy;
}

/** Exported `key` value of a span whose only attribute is `key: value`. */
function exported(key: string, value: AttributeValue): AttributeValue | undefined {
  return redact(readable({ [key]: value })).attributes[key];
}

/** Everything an exporter could serialise from `spans`. */
function serialized(spans: ReadableSpan[]): string {
  return JSON.stringify(spans.map((span) => ({ ...span, spanContext: span.spanContext(), resource: span.resource.attributes })));
}

const SQL_CASES: { name: string; text: string; expected: string }[] = [
  { name: 'a statement with a phone number, a string and a customer comment', text: PII_SQL, expected: PII_SQL_MASKED },
  { name: 'an integer', text: `SELECT * FROM t WHERE id = 42`, expected: `SELECT * FROM t WHERE id = ${REDACTED}` },
  {
    name: 'decimals and exponents',
    text: `WHERE p > 3.14 AND r < .5 AND e = 1e10 AND f = 2.5E-3`,
    expected: `WHERE p > ${REDACTED} AND r < ${REDACTED} AND e = ${REDACTED} AND f = ${REDACTED}`,
  },
  { name: 'a number after an operator', text: `WHERE delta >= -7 AND n = x-${PHONE}`, expected: `WHERE delta >= -${REDACTED} AND n = x-${REDACTED}` },
  {
    name: 'an IN list',
    text: `WHERE phone IN (1, 22, ${PHONE})`,
    expected: `WHERE phone IN (${REDACTED}, ${REDACTED}, ${REDACTED})`,
  },
  { name: 'LIMIT and OFFSET', text: `SELECT a FROM t LIMIT 10 OFFSET 20`, expected: `SELECT a FROM t LIMIT ${REDACTED} OFFSET ${REDACTED}` },
  {
    name: 'PostgreSQL 16 integer forms and trailing junk',
    text: `SELECT 0x1F, 0o17, 0b101, 1_000_000, ${PHONE}abc`,
    expected: `SELECT ${REDACTED}, ${REDACTED}, ${REDACTED}, ${REDACTED}, ${REDACTED}`,
  },
  {
    name: 'identifiers with digits, positional parameters, quoted identifiers and casts',
    text: `SELECT t1.col_2, "t1"."3d", c10_people_app, ñ1, x::bigint FROM schema2.table1 WHERE id = $1 AND v = $12::int4`,
    expected: `SELECT t1.col_2, "t1"."3d", c10_people_app, ñ1, x::bigint FROM schema2.table1 WHERE id = $1 AND v = $12::int4`,
  },
  {
    name: 'a cast literal and type modifiers',
    text: `SELECT '${PHONE}'::bigint, x::numeric(10, 2)`,
    expected: `SELECT '${REDACTED}'::bigint, x::numeric(${REDACTED}, ${REDACTED})`,
  },
  {
    name: 'existing string, escape-string and dollar-quoted literals',
    text: `WHERE a = '${WORD}''s' AND b = E'it\\'s ${PERSON}' AND c = $q$${PERSON}$q$ AND d = $$${PHONE}$$`,
    expected: `WHERE a = '${REDACTED}' AND b = '${REDACTED}' AND c = '${REDACTED}' AND d = '${REDACTED}'`,
  },
  {
    name: 'a line comment',
    text: `SELECT a -- customer ${PERSON} ${PHONE}\nFROM t`,
    expected: `SELECT a -- ${REDACTED}\nFROM t`,
  },
  { name: 'a line comment at the end', text: `SELECT 1; -- ${PERSON}`, expected: `SELECT ${REDACTED}; -- ${REDACTED}` },
  { name: 'a block comment', text: `SELECT /* ${PERSON} */ a FROM t`, expected: `SELECT /* ${REDACTED} */ a FROM t` },
  { name: 'an empty block comment', text: `SELECT/**/1`, expected: `SELECT/* ${REDACTED} */${REDACTED}` },
  {
    name: 'a nested-looking block comment',
    text: `SELECT /* outer /* ${PERSON} */ ${PERSON} */ a FROM t`,
    expected: `SELECT /* ${REDACTED} */`,
  },
  { name: 'an unterminated block comment', text: `SELECT a /* ${PERSON}`, expected: `SELECT a /* ${REDACTED} */` },
  {
    name: 'comment markers inside literals and identifiers',
    text: `SELECT '-- ${PERSON}', '/* ${PERSON}', "a--b" FROM t`,
    expected: `SELECT '${REDACTED}', '${REDACTED}', "a--b" FROM t`,
  },
];

describe('SQL text redaction', () => {
  it.each(SQL_CASES.flatMap((row) => ['db.query.text', 'db.statement'].map((key) => ({ ...row, key }))))(
    'masks $name in $key, stably',
    ({ key, text, expected }) => {
      const copy = redact(readable({ [key]: text }));

      expect(copy.attributes[key]).toBe(expected);
      expect(exported(key, expected)).toBe(expected);
      for (const sentinel of SENTINELS) expect(serialized([copy])).not.toContain(sentinel);
    },
  );

  it.each<{ name: string; expected: string }>([
    { name: DB_SPAN_NAME, expected: DB_SPAN_NAME },
    { name: `pg.query:VALUES(${PHONE}) masa_services_c10`, expected: `pg.query:VALUES(${REDACTED}) masa_services_c10` },
    { name: `pg.query:SELECT/*${PERSON}*/ db`, expected: `pg.query:SELECT/* ${REDACTED} */ db` },
  ])('masks the database span name $name', ({ name, expected }) => {
    expect(redact(readable({ 'db.query.text': PII_SQL }, name)).name).toBe(expected);
  });

  it.each<{ name: string; text: string }>([
    { name: 'nested comment openers', text: '/*'.repeat(100_000) },
    { name: 'unterminated comment stars', text: '/* *'.repeat(50_000) },
    { name: 'comment closers', text: '*/'.repeat(100_000) },
    { name: 'dashes', text: '-'.repeat(200_000) },
    { name: 'double quotes', text: '"'.repeat(200_001) },
    { name: 'doubled quoted-identifier quotes', text: '"a""'.repeat(50_000) },
    { name: 'single quotes', text: "'".repeat(200_001) },
    { name: 'escape-string escapes', text: `E'${"\\'".repeat(100_000)}` },
    { name: 'dollar tags', text: `$q$${'$q'.repeat(100_000)}` },
    { name: 'digits with trailing junk', text: '1e'.repeat(100_000) },
    { name: 'signed exponents', text: '1e-'.repeat(70_000) },
    { name: 'a long number', text: `${'9'.repeat(200_000)}x` },
    { name: 'mixed tokens', text: "a1 'b' /*c*/ 2 -- d\n".repeat(12_000) },
  ])('masks $name of 200 KB in linear time', ({ text }) => {
    expect(text.length).toBeGreaterThanOrEqual(200_000);
    const started = performance.now();

    const copy = redact(readable({ 'db.query.text': text }, text));

    expect(performance.now() - started).toBeLessThan(1_000);
    expect(typeof copy.attributes['db.query.text']).toBe('string');
  });
});

describe('bind value and credential header redaction', () => {
  it.each<{ key: string; value: AttributeValue; expected: AttributeValue }>([
    { key: 'db.postgresql.values', value: [Number(PHONE), 42], expected: [REDACTED, REDACTED] },
    { key: 'db.postgresql.values', value: [true, false], expected: [REDACTED, REDACTED] },
    { key: 'db.postgresql.values', value: [WORD, null], expected: [REDACTED, null] },
    { key: 'db.query.parameter.phone', value: Number(PHONE), expected: REDACTED },
    { key: 'db.query.parameter.0', value: 3.14, expected: REDACTED },
    { key: 'db.query.parameter.active', value: true, expected: REDACTED },
    { key: 'db.query.parameter.ids', value: [Number(PHONE)], expected: [REDACTED] },
    { key: 'http.request.header.authorization', value: Number(PHONE), expected: REDACTED },
    { key: 'http.request.header.cookie', value: [Number(PHONE)], expected: [REDACTED] },
    { key: 'http.response.header.set-cookie', value: [true], expected: [REDACTED] },
    { key: 'http.response.status_code', value: 200, expected: 200 },
    { key: 'db.query.text', value: 7, expected: 7 },
    { key: 'opt2.flags', value: [true, false], expected: [true, false] },
  ])('exports $key value $value as $expected', ({ key, value, expected }) => {
    expect(exported(key, value)).toEqual(expected);
  });
});

describe('SQL privacy end to end', () => {
  afterEach(async () => {
    await shutdownTracing();
  });

  it('exports a database span without literals, comments or bind values, keeping its name, kind and trace', async () => {
    const exporter = new MemorySpanExporter();
    await startTracing({ serviceName: 'tracing-sql-redact-c10', version: '1.0.0', exporter });
    const ids: { traceId: string; spanId: string }[] = [];

    await startSpan('archive', SpanKind.INTERNAL, async (outer) => {
      ids.push(outer.spanContext());
      await startSpan(
        DB_SPAN_NAME,
        SpanKind.CLIENT,
        (span) => {
          ids.push(span.spanContext());
          span.setAttributes({ 'db.query.parameter.phone': Number(PHONE), 'db.query.parameter.active': true });
        },
        { 'db.system.name': 'postgresql', 'db.query.text': PII_SQL, 'db.postgresql.values': [PHONE, PERSON] },
      );
    });
    await flushTracing();
    const spans = exporter.getFinishedSpans();
    const query = spans.find((span) => span.kind === SpanKind.CLIENT);
    const [outerIds, queryIds] = ids;

    expect(spans).toHaveLength(2);
    for (const sentinel of SENTINELS) expect(serialized(spans)).not.toContain(sentinel);
    expect(query?.name).toBe(DB_SPAN_NAME);
    expect(query?.spanContext()).toMatchObject({ traceId: queryIds?.traceId, spanId: queryIds?.spanId });
    expect(query?.spanContext().traceId).toBe(outerIds?.traceId);
    expect(query?.parentSpanContext?.spanId).toBe(outerIds?.spanId);
    expect(query?.attributes).toEqual({
      'db.system.name': 'postgresql',
      'db.query.text': PII_SQL_MASKED,
      'db.postgresql.values': [REDACTED, REDACTED],
      'db.query.parameter.phone': REDACTED,
      'db.query.parameter.active': REDACTED,
    });
  });
});
