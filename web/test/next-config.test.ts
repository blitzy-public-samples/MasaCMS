import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';

describe('next.config', () => {
  it('never compresses responses', () => {
    expect(nextConfig.compress).toBe(false);
  });
});
