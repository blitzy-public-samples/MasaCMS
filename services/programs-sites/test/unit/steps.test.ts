/** Inventory parity of the site-monitor step table. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SITE_MONITOR_STEPS, TARGET_CAPABLE_STEPS, stepNamed } from '../../src/jobs/steps.js';
import type { SiteMonitorStepName } from '../../src/jobs/steps.js';

interface InventoryStep {
  readonly step: string;
  readonly writeSet: readonly { readonly unit: string }[];
  readonly targetMechanism: string;
}

interface InventoryJob {
  readonly id: string;
  readonly registration?: { readonly url: string };
  readonly steps: readonly InventoryStep[];
}

const inventory = JSON.parse(
  readFileSync(new URL('../../../../opt2/inventory/legacy-inventory.json', import.meta.url), 'utf8'),
) as { readonly scheduledJobs: readonly InventoryJob[] };

const siteMonitorJob = inventory.scheduledJobs.find(
  (j) => j.id.startsWith('job:') && j.registration?.url.includes('/_api/sitemonitor') === true,
);
if (siteMonitorJob === undefined) throw new Error('legacy inventory records no job: entry for /_api/sitemonitor');
const inventorySteps = siteMonitorJob.steps;
const inventoryByLabel = new Map(inventorySteps.map((s) => [s.step, s]));

const LEGACY_ORDER: readonly SiteMonitorStepName[] = [
  'sendReminders', // contentServer.cfc:679-683
  'emailSend', // contentServer.cfc:685
  'publishScheduledChangesets', // contentServer.cfc:687
  'trackBounces', // contentServer.cfc:691-695
  'feedAutoImport', // contentServer.cfc:697-699
  'purgeDisplayWindow', // contentServer.cfc:702-733
  'clearOldCommands', // contentServer.cfc:735
  'onGlobalMonitor', // contentServer.cfc:737
  'onSiteMonitor', // contentServer.cfc:739-743
  'setCursor', // contentServer.cfc:745
];

/** Elements of `from` left after removing one occurrence of each element of `remove`. */
function difference(from: readonly string[], remove: readonly string[]): string[] {
  const pending = [...remove];
  return from.filter((unit) => {
    const at = pending.indexOf(unit);
    if (at < 0) return true;
    pending.splice(at, 1);
    return false;
  });
}

describe('site-monitor step table', () => {
  // The inventory labels steps differently and records both plugin events as one step; `inventoryStep` names that label.
  it.each(SITE_MONITOR_STEPS.map((s) => s.step))('gives %s the units of its inventory write set', (name) => {
    const def = stepNamed(name);
    const recorded = def.inventoryStep === undefined ? undefined : inventoryByLabel.get(def.inventoryStep);
    if (def.inventoryStep === undefined) {
      expect(name, `${name} has no inventory step`).toBe('setCursor');
    } else {
      expect(recorded, `${name}: inventory records no step '${def.inventoryStep}'`).toBeDefined();
    }
    // setCursor writes only application scope (contentServer.cfc:745).
    const expected = [...new Set(recorded?.writeSet.map((w) => w.unit) ?? [])].sort();
    const actual = [...def.units].sort();
    expect({ step: name, missing: difference(expected, actual), extra: difference(actual, expected) }).toEqual({
      step: name,
      missing: [],
      extra: [],
    });
  });

  it('maps every inventory step to a table entry', () => {
    const labels = new Set(SITE_MONITOR_STEPS.map((s) => s.inventoryStep));
    expect(inventorySteps.map((s) => s.step).filter((label) => !labels.has(label))).toEqual([]);
  });

  it('lists the steps in legacy execution order, matching the inventory sequence', () => {
    expect(SITE_MONITOR_STEPS.map((s) => s.step)).toEqual(LEGACY_ORDER);
    const tableLabels = SITE_MONITOR_STEPS.flatMap((s) => (s.inventoryStep === undefined ? [] : [s.inventoryStep]));
    const tableSequence = tableLabels.filter((label, i) => label !== tableLabels[i - 1]);
    expect(inventorySteps.map((s) => s.step).filter((label) => tableLabels.includes(label))).toEqual(tableSequence);
  });

  it('routes exactly publishScheduledChangesets and feedAutoImport to target job paths', () => {
    const routed = SITE_MONITOR_STEPS.filter((s) => s.targetPath !== undefined);
    expect(TARGET_CAPABLE_STEPS).toEqual(routed.map((s) => s.step));
    expect(routed.map(({ step, targetPath }) => ({ step, targetPath }))).toEqual([
      { step: 'publishScheduledChangesets', targetPath: '/internal/v1/jobs/publish-scheduled-changesets' },
      { step: 'feedAutoImport', targetPath: '/internal/v1/jobs/feed-auto-import' },
    ]);
    const inventoryRoutes = inventorySteps
      .filter((s) => s.targetMechanism.startsWith('/internal/v1/jobs/'))
      .map((s) => ({ step: s.step, targetPath: s.targetMechanism.replace(/\?.*$/, '') }));
    expect(inventoryRoutes).toEqual(routed.map((s) => ({ step: s.inventoryStep, targetPath: s.targetPath })));
  });
});
