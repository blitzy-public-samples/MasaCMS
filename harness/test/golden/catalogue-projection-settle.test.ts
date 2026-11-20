// GS-CO-09: the projection settle between the approver's target reject and the admin's legacy-rendered page.
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadCatalogue, scenarioById, type Step } from '../../src/golden/catalogue.js';
import { inventoryRouteKeyForRequest } from '../../src/inventory/route-keys.js';
import { cutoverVersionPath } from '../../src/lib/paths.js';

interface VersionEntry {
  route: string;
  owningService: string;
  state: string;
  kind: string;
}

async function keyOf(step: Step): Promise<string> {
  const url = new URL(step.route, 'http://legacy.invalid');
  const result = await inventoryRouteKeyForRequest({
    method: step.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    form: step.form ?? {},
    headers: {},
  });
  return result.key;
}

describe('GS-CO-09 reject projection settle', () => {
  let reject: Step;
  let next: Step;
  let entries: Map<string, VersionEntry>;

  beforeAll(async () => {
    const { steps } = scenarioById(await loadCatalogue(), 'GS-CO-09');
    const at = steps.findIndex((step) => step.name === 'reject');
    expect(at).toBeGreaterThanOrEqual(0);
    reject = steps[at] as Step;
    next = steps[at + 1] as Step;
    const version = JSON.parse(await readFile(cutoverVersionPath('v0002', {}), 'utf8')) as { entries: VersionEntry[] };
    entries = new Map(version.entries.map((entry) => [entry.route, entry]));
  });

  it('follows a v0002 target write of one session with a legacy-rendered page of another', async () => {
    expect(entries.get(await keyOf(reject))).toMatchObject({ owningService: 'strategies-content', state: 'target', kind: 'write' });
    expect(entries.get(await keyOf(next))).toMatchObject({ state: 'legacy', kind: 'read' });
    expect(next.as).not.toBe(reject.as);
  });

  it('waits for the strategies-content projection after the reject', () => {
    expect(reject.settle).toBe('projection:strategies-content');
  });
});
