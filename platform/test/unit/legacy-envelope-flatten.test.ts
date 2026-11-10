import { describe, expect, it, vi } from 'vitest';
import { buildEnvelope, serializeResponse } from '../../src/legacy-compat/envelope.js';
import { createApiSerializer } from '../../src/legacy-compat/serializer.js';

describe('serializeResponse data flattening', () => {
  it.each([
    {
      holding: 'an object',
      json: '{"__proto__":{"polluted":"yes"},"id":"1"}',
      body: '{"apiversion":"v1","method":"findOne","__proto__":{"polluted":"yes"},"id":"1"}',
    },
    {
      holding: 'a string',
      json: '{"__proto__":"yes","id":"1"}',
      body: '{"apiversion":"v1","method":"findOne","__proto__":"yes","id":"1"}',
    },
  ])('keeps an own __proto__ key holding $holding as data and leaves the prototype unchanged', ({ json, body }) => {
    const serializer = createApiSerializer();
    const serialize = vi.spyOn(serializer, 'serialize');
    const data: unknown = JSON.parse(json);

    const result = serializeResponse(buildEnvelope({ method: 'findOne', data }), {
      useDataNamespace: 'false',
      serializer,
    });

    expect(result.body).toBe(body);
    expect(serialize).toHaveBeenCalledOnce();
    const flattened = serialize.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.getPrototypeOf(flattened)).toBe(Object.prototype);
    expect(Object.hasOwn(flattened, '__proto__')).toBe(true);
    expect(Object.hasOwn(flattened, 'data')).toBe(false);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('overwrites a top-level key ignoring case in place and appends new keys in data order', () => {
    const result = serializeResponse(buildEnvelope({ method: 'findOne', data: { Method: 'x', b: '2', a: '1' } }), {
      useDataNamespace: 'false',
    });

    expect(result.body).toBe('{"apiversion":"v1","method":"x","b":"2","a":"1"}');
  });
});
