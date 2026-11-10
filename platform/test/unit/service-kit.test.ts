import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixedClock, isClock, systemClock } from '../../src/service-kit/clock.js';

const INSTANT = '2026-11-10T08:57:16.524Z';
const INSTANT_MS = Date.parse(INSTANT);

afterEach(() => {
  vi.useRealTimers();
});

describe('systemClock', () => {
  it('reads the current system time as a new Date on each call', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(INSTANT_MS);
    const first = systemClock.now();
    vi.setSystemTime(INSTANT_MS + 1_000);
    const second = systemClock.now();
    expect(first.getTime()).toBe(INSTANT_MS);
    expect(second.getTime()).toBe(INSTANT_MS + 1_000);
    expect(second).not.toBe(first);
  });
});

describe('fixedClock', () => {
  it.each([
    ['a Date', new Date(INSTANT_MS)],
    ['an ISO string', INSTANT],
    ['epoch milliseconds', INSTANT_MS],
  ])('freezes at the instant given as %s', (_label, at) => {
    const clock = fixedClock(at);
    expect(clock.now().toISOString()).toBe(INSTANT);
    expect(clock.now().getTime()).toBe(INSTANT_MS);
  });

  it('returns an equal but distinct Date on each call', () => {
    const clock = fixedClock(INSTANT);
    const first = clock.now();
    const second = clock.now();
    expect(second).toStrictEqual(first);
    expect(second).not.toBe(first);
    first.setTime(0);
    expect(clock.now().getTime()).toBe(INSTANT_MS);
  });

  it('keeps its instant when the Date it was given is mutated', () => {
    const at = new Date(INSTANT_MS);
    const clock = fixedClock(at);
    at.setTime(0);
    expect(clock.now().getTime()).toBe(INSTANT_MS);
  });

  it('ignores changes to system time', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    const clock = fixedClock(INSTANT);
    vi.setSystemTime(INSTANT_MS + 60_000);
    expect(clock.now().getTime()).toBe(INSTANT_MS);
  });

  it.each([
    ['an unparseable string', 'not a date'],
    ['NaN', Number.NaN],
    ['an invalid Date', new Date(Number.NaN)],
  ])('throws TypeError naming %s', (_label, at) => {
    expect(() => fixedClock(at)).toThrow(TypeError);
    expect(() => fixedClock(at)).toThrow(`Invalid date for fixedClock: ${String(at)}`);
  });
});

describe('isClock', () => {
  it.each([
    ['systemClock', systemClock],
    ['a fixedClock', fixedClock(INSTANT)],
    ['an object with a now method', { now: () => new Date(0) }],
  ])('accepts %s', (_label, value) => {
    expect(isClock(value)).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a Date', new Date(0)],
    ['an empty object', {}],
    ['an object whose now is not a function', { now: 0 }],
    ['a number', 0],
    ['a string', 'now'],
  ])('rejects %s', (_label, value) => {
    expect(isClock(value)).toBe(false);
  });
});
