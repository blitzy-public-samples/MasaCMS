import { readFileSync } from 'node:fs';
import { fastify } from 'fastify';
import { pino, type Logger } from 'pino';
import { describe, expect, it } from 'vitest';
import { fastifyLoggerOptions, fastifySerializers } from '../../src/logging/fastify.js';
import { BASE_FIELD_KEYS, LOG_FIELD_KEYS, TRACE_FIELD_KEYS } from '../../src/logging/fields.js';

function capturingLogger(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = pino(
    { serializers: fastifySerializers },
    {
      write: (line: string) => {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
  return { logger, lines };
}

describe('fastifySerializers', () => {
  it.each(['req', 'res'] as const)('%s serializes a value to undefined', (key) => {
    expect(fastifySerializers[key]({ method: 'GET', url: '/', statusCode: 200 })).toBeUndefined();
  });

  it('drop req and res from pino output and keep other fields', () => {
    const { logger, lines } = capturingLogger();
    logger.info({ req: { url: '/' }, res: { statusCode: 200 }, route: '/' }, 'done');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ route: '/', msg: 'done' });
    expect(lines[0]).not.toHaveProperty('req');
    expect(lines[0]).not.toHaveProperty('res');
  });
});

describe('fastifyLoggerOptions', () => {
  it('passes the logger through with request logging disabled and the requestId label', () => {
    const logger = pino({ enabled: false });
    const options = fastifyLoggerOptions(logger);
    expect(options).toStrictEqual({ loggerInstance: logger, disableRequestLogging: true, requestIdLogLabel: 'requestId' });
    expect(options.loggerInstance).toBe(logger);
  });

  it('makes Fastify log route lines under requestId and no request lines', async () => {
    const { logger, lines } = capturingLogger();
    const app = fastify(fastifyLoggerOptions(logger));
    app.get('/ping', (request, reply) => {
      request.log.info('handled');
      return reply.send({ ok: true });
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/ping' });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ msg: 'handled' });
    expect(lines[0]).not.toHaveProperty('reqId');
    expect(typeof lines[0]?.requestId).toBe('string');
    expect(lines[0]?.requestId).not.toBe('');
  });
});

describe('log field key lists', () => {
  it('with timestamp, severity and message, name each log-record.v1 property exactly once', () => {
    const schema = JSON.parse(
      readFileSync(new URL('../../contracts/log-record.v1.json', import.meta.url), 'utf8'),
    ) as { properties: Record<string, unknown> };
    const keys: string[] = ['timestamp', 'severity', 'message', ...BASE_FIELD_KEYS, ...LOG_FIELD_KEYS, ...TRACE_FIELD_KEYS];
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.toSorted()).toStrictEqual(Object.keys(schema.properties).toSorted());
  });

  it('bind service, version and env as the base fields', () => {
    expect(BASE_FIELD_KEYS).toStrictEqual(['service', 'version', 'env']);
  });
});
