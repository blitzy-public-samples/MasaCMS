// cChangesets.loadtagarray against cchangesets/loadtagarray.cfm, read against its contract and inventory entry.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { GatewayUnavailableError } from '@/lib/gateway-client';
import { cchangesetsGate } from '@/screens/cchangesets';
import { changesetLoadTagArrayScreen } from '@/screens/cchangesets/loadtagarray';
import { findScreen, type FragmentScreen, type RawBody, type ScreenContext } from '@/screens/registry';
import { adminS2Request } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';
import { makeScreenContext } from '../../helpers/screen-context';

const PATH = '/v1/raw/cchangesets/loadtagarray';
const ROUTE = 'GET /opt2/svc/strategies-content/v1/raw/cchangesets/loadtagarray';
const ROUTE_KEY = 'admin:cchangesets.loadtagarray';
const CONTRACT_URL = new URL('../../../../services/strategies-content/contracts/openapi.yaml', import.meta.url);
const INVENTORY_URL = new URL('../../../../opt2/inventory/legacy-inventory.json', import.meta.url);

/** The contract operation fields this suite reads. */
interface RawOperation {
  readonly 'x-opt2-response-mode'?: string;
  readonly responses: Readonly<Record<string, { readonly content?: Readonly<Record<string, unknown>> }>>;
}

/** An inventoried action variant as `opt2/inventory/legacy-inventory.json` stores it. */
interface InventoryVariant {
  readonly routeKey: string;
  readonly owningService: string | null;
  readonly responseMode: string | null;
  readonly contentType: string | null;
}

interface Inventory {
  readonly controllers: ReadonlyArray<{
    readonly actions?: ReadonlyArray<{ readonly variants?: readonly InventoryVariant[] }>;
  }>;
}

/** strategies-content's GET operation on {@link PATH}. */
function rawOperation(): RawOperation {
  const contract = parse(readFileSync(CONTRACT_URL, 'utf8')) as { paths: Record<string, { get?: RawOperation }> };
  const operation = contract.paths[PATH]?.get;
  if (operation === undefined) throw new Error(`strategies-content declares no GET ${PATH}`);
  return operation;
}

/** The inventory variant of {@link ROUTE_KEY}. */
function inventoryVariant(): InventoryVariant {
  const inventory = JSON.parse(readFileSync(INVENTORY_URL, 'utf8')) as Inventory;
  const variant = inventory.controllers
    .flatMap((controller) => controller.actions ?? [])
    .flatMap((action) => action.variants ?? [])
    .find((candidate) => candidate.routeKey === ROUTE_KEY);
  if (variant === undefined) throw new Error(`The inventory has no ${ROUTE_KEY}`);
  return variant;
}

/** The single media type of the operation's 200 answer. */
function successContentType(operation: RawOperation): string {
  const types = Object.keys(operation.responses['200']?.content ?? {});
  const [only] = types;
  if (types.length !== 1 || only === undefined) throw new Error(`GET ${PATH} must declare one 200 content type`);
  return only;
}

const OPERATION = rawOperation();
const INVENTORIED = inventoryVariant();
const LEGACY_CONTENT_TYPE = successContentType(OPERATION);

// esapiEncode('javascript') leaves only alphanumerics, `,`, `.` and `_` as they are, so spaces become \x20.
const TAG_ARRAY_BODY =
  "[{id: 'news', toString: function() { return 'news'; } }," +
  "{id: 'o\\x27brien\\x20\\x26\\x20co', toString: function() { return 'o\\x27brien\\x20\\x26\\x20co'; } }]";
const EMPTY_BODY = '[]';
const ERROR_BODY = '{"error":{"code":"server_error","message":"Unhandled Exception"}}';
const SHELL_MARKUP = /<!doctype|<html|<body|mura-header|mura-layout/i;

/** The owner's 200 answer of `body` under the contract content type. */
const viewReply = (body: string): FakeReply => ({
  status: 200,
  headers: { 'content-type': LEGACY_CONTENT_TYPE },
  body,
});

const tagRequest = (): ScreenContext['req'] =>
  adminS2Request({ circuit: 'cchangesets', item: 'loadtagarray', rc: { siteid: 'tenant-a' } });

/** The registered definition, behind the cChangesets `before()` gate and defaults. */
function registeredScreen(): FragmentScreen {
  const def = findScreen('core:cchangesets', 'loadtagarray', tagRequest().rc);
  if (def?.mode !== 'fragment') throw new Error(`${ROUTE_KEY} is not registered as a fragment`);
  return def;
}

describe('cChangesets.loadtagarray', () => {
  let restore: () => void;
  let reply: FakeReply;
  let ctx: ScreenContext & { gateway: FakeGatewayClient };

  beforeEach(() => {
    restore = useTestEnv();
    reply = viewReply(TAG_ARRAY_BODY);
    ctx = makeScreenContext({ req: tagRequest(), gateway: fakeGatewayClient({ [ROUTE]: () => reply }) });
  });

  afterEach(() => {
    restore();
  });

  const render = async (): Promise<RawBody> => registeredScreen().render(ctx, undefined);

  describe('relay', () => {
    it('sends one GET with the request site', async () => {
      await render();

      const query = Object.fromEntries(Object.entries(ctx.req.rc));
      expect(ctx.req.action).toBe('core:cchangesets.loadtagarray');
      expect(ctx.gateway.calls).toEqual([{ service: 'strategies-content', method: 'GET', path: PATH, query }]);
      expect(query).toMatchObject({
        siteid: 'tenant-a',
        muraAction: 'core:cchangesets.loadtagarray',
      });
    });

    it.each<{ name: string; answer: () => FakeReply }>([
      { name: 'the tag cloud', answer: () => viewReply(TAG_ARRAY_BODY) },
      { name: 'an empty tag cloud', answer: () => viewReply(EMPTY_BODY) },
      {
        name: 'a service error',
        answer: () => ({
          status: 500,
          headers: { 'content-type': 'application/json;charset=utf-8' },
          body: ERROR_BODY,
        }),
      },
    ])('relays $name byte for byte', async ({ answer }) => {
      reply = answer();
      const sent = reply.body as string;

      const raw = await render();

      expect(raw).toEqual({
        status: reply.status,
        contentType: reply.headers?.['content-type'],
        body: Buffer.from(sent, 'utf8'),
      });
      expect(Buffer.from(raw.body as Uint8Array).toString('utf8')).not.toMatch(SHELL_MARKUP);
    });

    it('rejects with GatewayUnavailableError', async () => {
      const unavailable = new GatewayUnavailableError('strategies-content');
      ctx.gateway.failWith(unavailable);

      await expect(render()).rejects.toBe(unavailable);
    });
  });

  describe('definition', () => {
    it('is the inventoried strategies-content action', () => {
      expect(changesetLoadTagArrayScreen).toMatchObject({
        circuit: 'cchangesets',
        action: 'loadtagarray',
        owner: 'strategies-content',
        mode: INVENTORIED.responseMode,
      });
      expect(INVENTORIED.owningService).toBe(changesetLoadTagArrayScreen.owner);
    });

    it('matches the contract operation', () => {
      expect(OPERATION['x-opt2-response-mode']).toBe(INVENTORIED.responseMode);
      expect(LEGACY_CONTENT_TYPE).toBe('text/html;charset=UTF-8');
      expect(LEGACY_CONTENT_TYPE.split(';')[0]).toBe(INVENTORIED.contentType);
    });

    it('is registered behind the cChangesets gate', () => {
      expect(registeredScreen()).toMatchObject({
        circuit: changesetLoadTagArrayScreen.circuit,
        action: changesetLoadTagArrayScreen.action,
        mode: changesetLoadTagArrayScreen.mode,
        owner: changesetLoadTagArrayScreen.owner,
        gate: cchangesetsGate,
      });
    });
  });
});
