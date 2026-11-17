// Unit tests for jsonListStream: JSON.stringify's bytes, backpressure, the creating context and failure.
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { JSON_CONTENT_TYPE, jsonListStream } from '../../src/service-kit/json-stream.js';

type Batches = readonly (readonly unknown[])[];

/** Yields `batches` one at a time. */
async function* batchesOf(batches: Batches): AsyncGenerator<readonly unknown[]> {
  for (const batch of batches) yield batch;
}

/** Every byte `stream` produces. */
async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const many: Batches = Array.from({ length: 5 }, (_, b) => Array.from({ length: 3 }, (_, i) => ({ id: b * 3 + i, name: `n${b}-${i}` })));

const CASES: ReadonlyArray<[string, Record<string, unknown>, string, Batches, Record<string, unknown> | undefined]> = [
  ['no batch', { sourceId: 'S1', scheduleVersion: null }, 'items', [], { next: null }],
  ['one empty batch', { sourceId: 'S1' }, 'items', [[]], { next: null }],
  ['one batch', {}, 'data', [[{ a: 1 }, { b: [2, 3] }]], { next: null }],
  ['many batches with empty ones between them', { total: 15 }, 'data', [[], ...many.slice(0, 2), [], ...many.slice(2), []], { next: null }],
  ['no head or tail', {}, 'data', many, undefined],
  ['a key the head already holds, which keeps its place', { data: 'old', first: true }, 'data', many, { last: 'z' }],
  ['integer-like keys, which JSON.stringify writes first', { b: 1, '2': 'two' }, 'items', many, { '1': 'one', a: 0 }],
  [
    'special characters',
    { 'quo"te': 'back\\slash', ctl: '\u0000\u001f\b\t\n', sep: '\u2028\u2029' },
    'data',
    [
      ['é', '😀', '\ud800', '\udfff', '</script>', '"\\'],
      [null, undefined, () => 1, Symbol('s'), Number.NaN, -0, 1e21, new Date(Date.UTC(2026, 5, 30, 9, 0, 0, 125))],
      [{ nested: { 'k\n': ['\u007f', '\u0080'] }, omitted: undefined }],
    ],
    { next: null },
  ],
];

describe('jsonListStream', () => {
  it.each(CASES)('streams the bytes JSON.stringify gives for %s', async (_case, head, key, batches, tail) => {
    const expected = JSON.stringify({ ...head, [key]: batches.flat(), ...tail });

    const body = await collect(jsonListStream(head, key, batchesOf(batches), tail));

    expect(body.equals(Buffer.from(expected, 'utf8'))).toBe(true);
    expect(body.toString('utf8')).toBe(expected);
  });

  it('names the content type Fastify gives a JSON object reply', () => {
    expect(JSON_CONTENT_TYPE).toBe('application/json; charset=utf-8');
  });

  it('pulls no batch until its bytes are read, then one batch ahead of the reader', async () => {
    const total = 20;
    let pulled = 0;
    async function* counted(): AsyncGenerator<readonly unknown[]> {
      for (let i = 0; i < total; i += 1) {
        pulled += 1;
        yield [i];
      }
    }
    const stream = jsonListStream({}, 'data', counted(), { next: null });
    await sleep(20);
    expect(pulled).toBe(0);

    await new Promise((resolve) => stream.once('readable', resolve));
    expect(String(stream.read())).toBe('{"data":[');
    await new Promise((resolve) => stream.once('readable', resolve));
    await sleep(20);
    expect(pulled).toBeGreaterThan(0);
    expect(pulled).toBeLessThanOrEqual(2);

    const body = await collect(stream);
    expect(pulled).toBe(total);
    expect(`{"data":[${body.toString('utf8')}`).toBe(JSON.stringify({ data: Array.from({ length: total }, (_, i) => i), next: null }));
  });

  it('pulls every batch in the async context the stream was created in', async () => {
    const als = new AsyncLocalStorage<string>();
    const seen: (string | undefined)[] = [];
    async function* observed(): AsyncGenerator<readonly unknown[]> {
      for (let i = 0; i < 4; i += 1) {
        seen.push(als.getStore());
        await sleep(1);
        seen.push(als.getStore());
        yield ['y'.repeat(70_000)];
      }
    }
    const stream = als.run('request', () => jsonListStream({}, 'data', observed()));

    const body = await als.run('consumer', () => collect(stream));

    expect(JSON.parse(body.toString('utf8'))).toEqual({ data: Array.from({ length: 4 }, () => 'y'.repeat(70_000)) });
    expect(seen).toEqual(Array.from({ length: 8 }, () => 'request'));
  });

  it('destroys the stream with the error a batch fails with, after the bytes before it', async () => {
    const failure = new Error('batch read failed');
    async function* failing(): AsyncGenerator<readonly unknown[]> {
      yield [{ id: 1 }];
      throw failure;
    }
    const stream = jsonListStream({ total: 2 }, 'data', failing(), { next: null });
    const chunks: string[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));

    await expect(new Promise((_resolve, reject) => stream.once('error', reject))).rejects.toBe(failure);
    expect(stream.destroyed).toBe(true);
    expect(chunks.join('')).toBe('{"total":2,"data":[{"id":1}');
  });

  it('ends the batch source when the stream is destroyed before the last batch', async () => {
    let started = false;
    let finished = false;
    async function* endless(): AsyncGenerator<readonly unknown[]> {
      started = true;
      try {
        for (;;) yield ['z'];
      } finally {
        finished = true;
      }
    }
    const stream = jsonListStream({}, 'data', endless());
    while (!started) {
      await new Promise((resolve) => stream.once('readable', resolve));
      stream.read();
    }
    expect(finished).toBe(false);

    stream.destroy();
    await new Promise((resolve) => stream.once('close', resolve));

    expect(finished).toBe(true);
  });

  it('throws a TypeError when the tail replaces the list member', () => {
    expect(() => jsonListStream({}, 'data', batchesOf([]), { data: [] })).toThrow(TypeError);
  });
});
