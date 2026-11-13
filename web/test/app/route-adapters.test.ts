// The App Router adapters of the post-action and raw admin trees: segment config and delegation to their handler.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAdminAction, handleAdminRaw } from '@/lib/handlers';
import * as adminActions from '../../app/admin-actions/[circuit]/[action]/route';
import * as adminRaw from '../../app/admin-raw/[circuit]/[action]/route';
import { WEB_TEST_ORIGIN, routeParams } from '../helpers/requests';

vi.mock('@/lib/handlers', () => ({
  handleAdminAction: vi.fn(),
  handleAdminRaw: vi.fn(),
}));

const actionHandler = vi.mocked(handleAdminAction);
const rawHandler = vi.mocked(handleAdminRaw);

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each([
  { tree: 'admin-actions', route: adminActions, handler: actionHandler, other: rawHandler },
  { tree: 'admin-raw', route: adminRaw, handler: rawHandler, other: actionHandler },
])('$tree route', ({ tree, route, handler, other }) => {
  it('renders dynamically on the Node.js runtime', () => {
    expect(route.dynamic).toBe('force-dynamic');
    expect(route.runtime).toBe('nodejs');
  });

  it.each(['GET', 'POST'] as const)(
    '%s returns the handler response for the request and awaited params',
    async (method) => {
      const request = new Request(`${WEB_TEST_ORIGIN}/${tree}/cusers/update`, { method });
      const params = { circuit: 'cusers', action: 'update' };
      const response = new Response('legacy body', { status: 302 });
      handler.mockResolvedValueOnce(response);

      await expect(route[method](request, routeParams(params))).resolves.toBe(response);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]?.[0]).toBe(request);
      expect(handler.mock.calls[0]?.[1]).toBe(params);
      expect(other).not.toHaveBeenCalled();
    },
  );
});
