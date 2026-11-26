// The Next.js start-up hook boots the web process in the Node.js runtime only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootWeb } from '@/lib/boot';
import { register } from '../../instrumentation';

vi.mock('@/lib/boot', () => ({ bootWeb: vi.fn(async () => undefined) }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(bootWeb).mockClear();
});

describe('register', () => {
  it('boots the web process in the Node.js runtime and waits for it', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    const failure = new Error('boot failed');
    vi.mocked(bootWeb).mockRejectedValueOnce(failure);

    await expect(register()).rejects.toBe(failure);
    expect(vi.mocked(bootWeb)).toHaveBeenCalledExactlyOnceWith();
  });

  it.each([['the edge runtime', 'edge'], ['no runtime', undefined]])('does nothing in %s', async (_case, runtime) => {
    vi.stubEnv('NEXT_RUNTIME', runtime);

    await register();

    expect(vi.mocked(bootWeb)).not.toHaveBeenCalled();
  });
});
