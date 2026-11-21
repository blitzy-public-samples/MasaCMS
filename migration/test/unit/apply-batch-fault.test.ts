// Unit tests for the batch sender's applier-killed fault: OPT2_FAULT parsing, the acknowledged exit and the in-flight exit over undici's channels.
import { channel } from 'node:diagnostics_channel';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';

import type { ApplyRequest } from '@opt2/platform/migration-kit';
import { createServiceClient } from '@opt2/platform/service-kit';
import { describe, expect, it, vi } from 'vitest';

import {
  ApplyFaultConfigError,
  InFlightKillMissedError,
  batchIdFor,
  createBatchSender,
  inFlightKillLine,
  parseApplyFault,
  parseInFlightKill,
} from '../../src/apply/batch.js';
import type { ApplyFault, InFlightKill } from '../../src/apply/batch.js';
import { createOwnersClient } from '../../src/owners/index.js';
import type { ApplyResult, OwnersClient, UnitCatalog } from '../../src/owners/index.js';

const APPLY_PATH = '/internal/v1/migration/apply';
const TENANT = '00000000-0000-4000-8000-00000000000a';
const bodySent = channel('undici:request:bodySent');
const sendHeaders = channel('undici:client:sendHeaders');

/** What the injected `exit` throws, so a test sees the exit instead of losing its process. */
class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`exit(${String(code)})`);
  }
}

function request(ordinal: number, legacyTable = 'tusers'): ApplyRequest {
  return {
    batchId: batchIdFor({ direction: 'feed', snapshotSeq: 4, legacyTable, tenantId: TENANT, ordinal }),
    origin: 'migration-feed',
    legacyTable,
    tenantId: TENANT,
    columns: [{ name: 'UserID', type: 's' }],
    rows: [{ op: 'upsert', row: `s35:${String(ordinal).padEnd(35, 'x')}` }],
  };
}

function answer(req: ApplyRequest): ApplyResult {
  return { batchId: req.batchId, duplicate: false, applied: req.rows.length, skipped: 0, writePositions: new Map() };
}

/** A sender over `apply` with a throwing `exit` and a recording marker writer. */
function sender(fault: ApplyFault | null, apply: OwnersClient['apply']) {
  const exit = vi.fn((code: number): never => {
    throw new ExitCalled(code);
  });
  const writeMarker = vi.fn<(line: string) => void>();
  const owners = { apply: vi.fn(apply), putWatermark: vi.fn(() => Promise.reject(new Error('no watermark expected'))) };
  return { batches: createBatchSender({ owners, fault, exit, writeMarker }), exit, writeMarker, owners };
}

/** An owner apply that publishes undici's body-sent message for each of `requests` and then never answers. */
function sentWithoutAnswer(...requests: unknown[]): OwnersClient['apply'] {
  return () => {
    for (const sent of requests) bodySent.publish({ request: sent });
    return new Promise<ApplyResult>(() => undefined);
  };
}

function expectUnsubscribed(): void {
  expect(bodySent.hasSubscribers).toBe(false);
  expect(sendHeaders.hasSubscribers).toBe(false);
}

describe('parseApplyFault', () => {
  it.each<[string | undefined, ApplyFault | null]>([
    [undefined, null],
    ['', null],
    ['roster:people-commit', null],
    ['apply:kill-after:3', { point: 'acknowledged', batch: 3 }],
    [' roster:identity-commit , apply:kill-in-flight:2 ', { point: 'in-flight', batch: 2 }],
  ])('reads %j as %j', (value, expected) => {
    expect(parseApplyFault(value)).toStrictEqual(expected);
  });

  it.each(['apply:kill-after:0', 'apply:kill-in-flight:', 'apply:kill-in-flight:1.5', 'apply:kill-during:1', 'apply:kill-in-flight:-2'])(
    'rejects the malformed entry %j, naming both forms',
    (value) => {
      expect(() => parseApplyFault(value)).toThrow(
        new ApplyFaultConfigError(`OPT2_FAULT entry "${value}" is not apply:kill-after:<positive integer> or apply:kill-in-flight:<positive integer>`),
      );
    },
  );

  it('rejects two apply entries', () => {
    expect(() => parseApplyFault('apply:kill-after:1,apply:kill-in-flight:2')).toThrow(
      new ApplyFaultConfigError('OPT2_FAULT holds 2 apply entries; at most one is allowed'),
    );
  });
});

describe('parseInFlightKill', () => {
  const first: InFlightKill = { owner: 'identity', legacyTable: 'tusers', batchId: 'a'.repeat(64), batch: 1 };
  const last: InFlightKill = { owner: 'people', legacyTable: 'tusersmemb', batchId: 'b'.repeat(64), batch: 2 };

  it('reads the last marker of a stderr tail between log lines and a cut first line', () => {
    const tail = `in-flight","owner":"x"}\n{"level":30,"msg":"feed started"}\n${inFlightKillLine(first)}${inFlightKillLine(last)}`;

    expect(parseInFlightKill(tail)).toStrictEqual(last);
  });

  it.each([
    '',
    '{"level":30,"msg":"apply:kill-in-flight armed"}\n',
    '{"fault":"apply:kill-in-flight","owner":"people","legacyTable":"tusers","batch":1}\n',
    '{"fault":"apply:kill-in-flight","owner":"people","legacyTable":"tusers","batchId":"b","batch":0}\n',
    'apply:kill-in-flight owner=people batchId=b\n',
  ])('finds no marker in %j', (tail) => {
    expect(parseInFlightKill(tail)).toBeNull();
  });
});

describe('createBatchSender', () => {
  it('sends every batch once and never exits when unarmed', async () => {
    const { batches, exit } = sender(null, (_owner, req) => Promise.resolve(answer(req)));

    for (const ordinal of [0, 1, 2]) await expect(batches.apply('people', request(ordinal))).resolves.toMatchObject({ duplicate: false });

    expect(exit).not.toHaveBeenCalled();
    expect(batches.acknowledged).toBe(3);
  });

  it('exits with 137 once the owner acknowledged the armed batch', async () => {
    const { batches, exit, writeMarker, owners } = sender({ point: 'acknowledged', batch: 2 }, (_owner, req) => Promise.resolve(answer(req)));

    await batches.apply('people', request(0));
    expect(exit).not.toHaveBeenCalled();
    await expect(batches.apply('people', request(1))).rejects.toStrictEqual(new ExitCalled(137));

    expect(owners.apply).toHaveBeenCalledTimes(2);
    expect(batches.acknowledged).toBe(2);
    expect(writeMarker).not.toHaveBeenCalled();
  });

  it('exits with 137 and names the batch once the armed apply body was sent, before the owner answers', async () => {
    const armed = sentWithoutAnswer({ method: 'POST', path: `${APPLY_PATH}?trace=1` });
    const { batches, exit, writeMarker } = sender({ point: 'in-flight', batch: 2 }, (owner, req) =>
      req.batchId === request(0).batchId ? Promise.resolve(answer(req)) : armed(owner, req),
    );

    await batches.apply('identity', request(0));
    await expect(batches.apply('people', request(1, 'tusersmemb'))).rejects.toStrictEqual(new ExitCalled(137));

    expect(exit).toHaveBeenCalledExactlyOnceWith(137);
    expect(writeMarker).toHaveBeenCalledOnce();
    const line = writeMarker.mock.calls[0]?.[0] ?? '';
    expect(line.endsWith('\n')).toBe(true);
    expect(parseInFlightKill(line)).toStrictEqual({ owner: 'people', legacyTable: 'tusersmemb', batchId: request(1, 'tusersmemb').batchId, batch: 2 });
    expect(batches.acknowledged).toBe(1);
    expectUnsubscribed();
  });

  it('waits until the socket of the sent apply has flushed before exiting', async () => {
    let release: () => void = () => undefined;
    const socket = new Writable({
      write(_chunk, _encoding, callback) {
        release = () => callback();
      },
    });
    socket.write('queued request bytes');
    const sent = { method: 'POST', path: APPLY_PATH };
    const { batches, exit } = sender({ point: 'in-flight', batch: 1 }, () => {
      sendHeaders.publish({ request: sent, headers: '', socket });
      bodySent.publish({ request: sent });
      return new Promise<ApplyResult>(() => undefined);
    });

    const applying = batches.apply('people', request(0));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(socket.writableLength).toBeGreaterThan(0);
    expect(exit).not.toHaveBeenCalled();
    release();

    await expect(applying).rejects.toStrictEqual(new ExitCalled(137));
    expect(socket.writableLength).toBe(0);
    expectUnsubscribed();
  });

  it.each<[string, unknown[]]>([
    ['no request', [undefined]],
    ['a POST to another migration route', [{ method: 'POST', path: '/internal/v1/migration/gate' }]],
    ['a GET of the apply path', [{ method: 'GET', path: APPLY_PATH }]],
    ['a POST to a longer path', [{ method: 'POST', path: `${APPLY_PATH}-preview` }]],
  ])('ignores the body sent of %s and fails when the owner answers first', async (_label, requests) => {
    const { batches, exit, writeMarker } = sender({ point: 'in-flight', batch: 1 }, (_owner, req) => {
      for (const sent of requests) bodySent.publish({ request: sent });
      return Promise.resolve(answer(req));
    });

    await expect(batches.apply('people', request(0))).rejects.toThrow(InFlightKillMissedError);

    expect(exit).not.toHaveBeenCalled();
    expect(writeMarker).not.toHaveBeenCalled();
    expectUnsubscribed();
  });

  it('propagates an armed apply that fails before its body was sent', async () => {
    const refused = new Error('Service people unavailable (ECONNREFUSED)');
    const { batches, exit } = sender({ point: 'in-flight', batch: 1 }, () => Promise.reject(refused));

    await expect(batches.apply('people', request(0))).rejects.toBe(refused);

    expect(exit).not.toHaveBeenCalled();
    expectUnsubscribed();
  });

  it('exits through the real service client after the owner received the whole body and before it replied', async () => {
    const events: string[] = [];
    let received = Buffer.alloc(0);
    let bodyComplete: () => void = () => undefined;
    const complete = new Promise<void>((resolve) => {
      bodyComplete = resolve;
    });
    let replied: () => void = () => undefined;
    const reply = new Promise<void>((resolve) => {
      replied = resolve;
    });
    const sent = request(0);
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received = Buffer.concat(chunks);
        events.push('body-complete');
        bodyComplete();
        // Held, so the apply is still in flight when the client exits.
        setTimeout(() => {
          events.push('replied');
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer(sent)), () => replied());
        }, 2000);
      });
    });
    server.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const client = createServiceClient({
      serviceUrls: { people: `http://127.0.0.1:${String(port)}` },
      self: 'migration',
      credentials: { headersFor: () => Promise.resolve({}) },
    });
    const exit = vi.fn((code: number): never => {
      events.push('exit');
      throw new ExitCalled(code);
    });
    const writeMarker = vi.fn<(line: string) => void>();
    // The owners client reads no catalog fact on its migration routes.
    const owners = createOwnersClient({ client, catalog: {} as UnitCatalog });
    const batches = createBatchSender({ owners, fault: { point: 'in-flight', batch: 1 }, exit, writeMarker });

    try {
      await expect(batches.apply('people', sent)).rejects.toStrictEqual(new ExitCalled(137));
      await complete;

      expect(events).toStrictEqual(expect.arrayContaining(['exit', 'body-complete']));
      expect(events).not.toContain('replied');
      expect(JSON.parse(received.toString('utf8'))).toStrictEqual(sent);
      expect(parseInFlightKill(writeMarker.mock.calls[0]?.[0] ?? '')).toStrictEqual({ owner: 'people', legacyTable: 'tusers', batchId: sent.batchId, batch: 1 });
      expectUnsubscribed();
    } finally {
      // The held reply is awaited only once the server has the request; the client closes after its last answer.
      if (events.includes('body-complete')) await reply;
      await client.close();
      await new Promise((resolve) => server.close(resolve));
    }
    expect(events.indexOf('exit')).toBeLessThan(events.indexOf('replied'));
  });
});
