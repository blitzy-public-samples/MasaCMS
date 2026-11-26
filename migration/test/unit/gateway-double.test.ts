// Unit tests for the gateway double's orphan clearing, held to the real gateway's gates-closed rule, and its two status generations.
import { fixedClock } from '@opt2/platform/service-kit';
import { describe, expect, it } from 'vitest';

import type { InflightClearRequest } from '../../src/cutover/index.js';
import { createGatewayDouble, type GatewayInflightRow } from '../helpers/gateway-double.js';

const NOW = '2026-06-30T12:00:00.000Z';
const STARTED_AT = Date.parse('2026-06-30T11:59:00.000Z');
const ROUTE_GATED = 'admin:cusers.update{type=2,action=add}';
const ROUTE_PARTLY_GATED = 'admin:cusers.update{type=1}';
const ROUTE_UNKNOWN = 'api:user.save';
const ROUTE_NO_UNITS = 'api:content.save';
const GATED_UNITS = ['identity.user_account', 'people.person'];
const GATES_CLOSED: InflightClearRequest = {
  side: 'target',
  evidence: { kind: 'gates-closed', holderId: 'trn-2', at: NOW, units: [...GATED_UNITS, 'identity.group_account'] },
};

interface UnitCase {
  name: string;
  route: string;
  units: string[] | undefined;
  outcome: 'keeps' | 'clears';
}

const UNIT_CASES: UnitCase[] = [
  { name: 'unknown', route: ROUTE_UNKNOWN, units: undefined, outcome: 'keeps' },
  { name: 'empty', route: ROUTE_NO_UNITS, units: [], outcome: 'keeps' },
  { name: 'partially covered', route: ROUTE_PARTLY_GATED, units: ['identity.group_account', 'identity.membership'], outcome: 'keeps' },
  { name: 'fully covered', route: ROUTE_GATED, units: GATED_UNITS, outcome: 'clears' },
];

/** A dead instance's target-side row on `route`, started before the evidence. */
function deadTarget({ route, units }: Pick<UnitCase, 'route' | 'units'>): GatewayInflightRow {
  const row: GatewayInflightRow = { instance: 'gw-gone', requestId: `gone ${route}`, route, side: 'target', startedAt: STARTED_AT, orphan: true };
  return units === undefined ? row : { ...row, units };
}

/** Dead target-side rows of every unit case, a live instance's covered row and a dead legacy-side row on a covered route. */
function mixedRows(): GatewayInflightRow[] {
  return [
    { instance: 'gw-live', requestId: 'live-gated', route: ROUTE_GATED, side: 'target', startedAt: STARTED_AT, units: GATED_UNITS },
    ...UNIT_CASES.map(deadTarget),
    { instance: 'gw-gone', requestId: 'gone-legacy', route: ROUTE_GATED, side: 'legacy', startedAt: STARTED_AT, orphan: true, units: GATED_UNITS },
  ];
}

const KEPT_MIXED = ['gone-legacy', `gone ${ROUTE_NO_UNITS}`, `gone ${ROUTE_PARTLY_GATED}`, `gone ${ROUTE_UNKNOWN}`, 'live-gated'].sort();

const requestIds = (rows: readonly GatewayInflightRow[]): string[] => rows.map((row) => row.requestId).sort();

describe('gateway double clearOrphans with gates-closed evidence', () => {
  it.each(UNIT_CASES)('$outcome a dead target-side row with $name units', async (unitCase) => {
    const row = deadTarget(unitCase);
    const gateway = createGatewayDouble({ clock: fixedClock(NOW), inflight: [row] });

    await expect(gateway.clearOrphans(GATES_CLOSED)).resolves.toEqual({ cleared: unitCase.outcome === 'clears' ? 1 : 0 });
    expect(gateway.inflightRows()).toStrictEqual(unitCase.outcome === 'clears' ? [] : [row]);
  });

  it('clears only the fully covered dead target-side row among live, uncovered and legacy-side rows', async () => {
    const gateway = createGatewayDouble({ clock: fixedClock(NOW), inflight: mixedRows() });

    await expect(gateway.clearOrphans(GATES_CLOSED)).resolves.toEqual({ cleared: 1 });
    expect(requestIds(gateway.inflightRows())).toEqual(KEPT_MIXED);
  });

  it("reports a live instance's abandoned row orphaned and clears it, but not that instance's running row", async () => {
    const running: GatewayInflightRow = { instance: 'gw-live', requestId: 'live-running', route: ROUTE_GATED, side: 'target', startedAt: STARTED_AT, units: GATED_UNITS };
    const gateway = createGatewayDouble({ clock: fixedClock(NOW), inflight: [running, { ...running, requestId: 'live-abandoned', abandoned: true }] });

    expect(gateway.snapshot().inflight).toEqual([{ instanceId: 'gw-live', route: ROUTE_GATED, side: 'target', count: 2, oldestStartedAt: expect.any(String) }]);
    expect(gateway.snapshotV2().inflight.map(({ instanceId, count, orphaned }) => ({ instanceId, count, orphaned }))).toEqual([
      { instanceId: 'gw-live', count: 1, orphaned: false },
      { instanceId: 'gw-live', count: 1, orphaned: true },
    ]);
    await expect(gateway.clearOrphans(GATES_CLOSED)).resolves.toEqual({ cleared: 1 });
    expect(requestIds(gateway.inflightRows())).toEqual(['live-running']);
  });

  it('answers the same over POST /internal/v1/inflight:clear-orphans', async () => {
    const gateway = createGatewayDouble({ clock: fixedClock(NOW), inflight: mixedRows() });
    const listener = await gateway.listen();
    try {
      const res = await fetch(`${listener.url}/internal/v1/inflight:clear-orphans`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(GATES_CLOSED),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ cleared: 1 });
    } finally {
      await listener.close();
    }
    expect(requestIds(gateway.inflightRows())).toEqual(KEPT_MIXED);
  });
});

describe('gateway double status generations', () => {
  const running: GatewayInflightRow = { instance: 'gw-live', requestId: 'live-running', route: ROUTE_GATED, side: 'target', startedAt: STARTED_AT };
  const rows = (): GatewayInflightRow[] => [running, { ...running, requestId: 'live-abandoned', abandoned: true }];

  it.each(['v1', 'v2'] as const)('serves the v1 status without orphaned, and the v2 status only as a %s gateway does', async (generation) => {
    const gateway = createGatewayDouble({ clock: fixedClock(NOW), generation, inflight: rows() });
    const listener = await gateway.listen();
    try {
      const v1 = await fetch(`${listener.url}/internal/v1/cutover/status`);
      const v2 = await fetch(`${listener.url}/internal/v2/cutover/status`);
      expect([v1.status, v2.status]).toEqual([200, generation === 'v2' ? 200 : 404]);
      expect(await v1.json()).toEqual(gateway.snapshot());
      expect(await v2.json()).toEqual(generation === 'v2' ? gateway.snapshotV2() : expect.objectContaining({ error: expect.any(Object) }));
    } finally {
      await listener.close();
    }
    expect(gateway.calls.map((call) => call.op)).toEqual(generation === 'v2' ? ['status', 'inflightStatus'] : ['status']);
  });

  it.each([
    ['v2', [false, true]],
    ['v1', [false]],
  ] as const)("reports a live instance's abandoned row from inflightStatus as a %s gateway's client does", async (generation, orphaned) => {
    const gateway = createGatewayDouble({ clock: fixedClock(NOW), generation, inflight: rows() });

    expect((await gateway.inflightStatus()).inflight.map((group) => group.orphaned)).toEqual(orphaned);
  });
});
