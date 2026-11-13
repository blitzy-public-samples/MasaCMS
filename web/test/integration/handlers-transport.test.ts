// The handlers over the production client when the gateway refuses the connection: the legacy 503, logged once.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LEGACY_ERROR_PAGE_HTML } from '@opt2/platform/legacy-compat';
import { ServiceUnavailableError } from '@opt2/platform/service-kit';
import { GatewayUnavailableError, setServiceClientForTests } from '@/lib/gateway-client';
import { logRequest } from '@/lib/telemetry';
import type { SubmitResult } from '@/screens/registry';
import { useTestEnv } from '../helpers/env';
import { startFakeGateway, type FakeGateway } from '../helpers/fake-gateway';
import { adminRequest } from '../helpers/requests';

vi.mock('@/lib/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/telemetry')>()),
  ensureTracing: vi.fn(async () => undefined),
  logRequest: vi.fn(),
}));

vi.mock('@/screens/registry', async () => {
  const { html, raw } = await import('@/lib/html');
  const base = { circuit: 'cusers', owner: 'people', gate: () => ({ kind: 'allow' }) };
  const screens = [
    { ...base, action: 'list', mode: 'page', render: () => ({ body: html`<p id="list">list</p>` }) },
    {
      ...base,
      action: 'update',
      mode: 'redirect',
      submit: (): Promise<SubmitResult> => Promise.resolve({ kind: 'location', location: './' }),
    },
  ];
  return {
    findScreen: (circuit: string, action: string) =>
      screens.find((screen) => screen.circuit === circuit && screen.action === action),
    findOpt2Screen: () => undefined,
    findOpt2Action: () => undefined,
    shellHooks: { secondaryMenus: {}, contentNav: () => raw('') },
  };
});

const { handleAdminAction, handleAdminPage } = await import('@/lib/handlers');

let fake: FakeGateway;
let restoreEnv: () => void;
let restoreClient: () => void;

beforeEach(async () => {
  fake = await startFakeGateway();
  await fake.refuse();
  restoreEnv = useTestEnv({ OPT2_GATEWAY_URL: fake.url });
  restoreClient = setServiceClientForTests(undefined);
  vi.mocked(logRequest).mockClear();
});

afterEach(async () => {
  restoreClient();
  restoreEnv();
  await fake.close();
});

it.each<{
  route: string;
  method: string;
  handle: typeof handleAdminPage;
  path: string;
  action: string;
  form?: Record<string, string>;
}>([
  { route: 'page:cusers.list', method: 'GET', handle: handleAdminPage, path: '/admin/cusers/list', action: 'list' },
  {
    route: 'redirect:cusers.update',
    method: 'POST',
    handle: handleAdminAction,
    path: '/admin-actions/cusers/update',
    action: 'update',
    form: { userid: 'U1' },
  },
])('answers $route with the legacy 503 when the gateway refuses the connection', async (input) => {
  const { route, method, handle, path, action, form } = input;
  const response = await handle(await adminRequest(path, { user: 'admin', form }), { circuit: 'cusers', action });

  expect(response.status).toBe(503);
  expect(await response.text()).toBe(LEGACY_ERROR_PAGE_HTML);
  expect(fake.requests).toEqual([]);
  const lines = vi.mocked(logRequest).mock.calls.map(([fields]) => fields);
  expect(lines).toEqual([expect.objectContaining({ route, httpMethod: method, statusCode: 503 })]);
  const error = lines[0]?.error;
  expect(error).toBeInstanceOf(GatewayUnavailableError);
  expect(error).toMatchObject({ status: undefined });
  expect((error as GatewayUnavailableError).cause).toBeInstanceOf(ServiceUnavailableError);
});
