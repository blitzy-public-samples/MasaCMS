// Unit tests for the scripted-fault registry and its barrel.
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import * as scripts from '../../src/faults/scripts/index.js';
import * as types from '../../src/faults/scripts/types.js';

const { FAULT_SCRIPTS } = scripts;

describe('FAULT_SCRIPTS', () => {
  it('lists every config fault once, in config order', () => {
    expect(Object.keys(FAULT_SCRIPTS)).toStrictEqual(loadConfig().faults.map((fault) => fault.name));
  });

  it.each(Object.entries(FAULT_SCRIPTS))('keys %s under its own script name', (key, script) => {
    expect(script.name).toBe(key);
  });

  it('reconciles after every fault except projector-delay', () => {
    const toggles = Object.values(FAULT_SCRIPTS)
      .filter((script) => !script.reconciles)
      .map((script) => script.name);
    expect(toggles).toStrictEqual(['projector-delay']);
  });

  it.each([
    ['applier-killed-mid-batch', scripts.applierKilledMidBatch],
    ['duplicate-batch', scripts.duplicateBatch],
    ['mssql-dropped-mid-extract', scripts.mssqlDroppedMidExtract],
    ['service-restarted-mid-apply', scripts.serviceRestartedMidApply],
    ['pubsub-redelivery', scripts.pubsubRedelivery],
    ['window-import-interrupted', scripts.windowImportInterrupted],
    ['projector-delay', scripts.projectorDelay],
    ['forced-reinit', scripts.forcedReinit],
  ] as const)('holds the re-exported %s script itself', (key, script) => {
    expect(FAULT_SCRIPTS[key]).toBe(script);
  });

  it('re-exports the assertion helpers of the script contract', () => {
    expect(scripts.pass).toBe(types.pass);
    expect(scripts.fail).toBe(types.fail);
    expect(scripts.skipped).toBe(types.skipped);
  });
});
