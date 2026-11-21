// Live snapshot of the inventory: the registration probe, catalog and stored-procedure check results of a `--live`
// run, written beside the inventory so a later run rebuilds the same inventory without the legacy oracle.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from '@opt2/platform/service-kit';
import type { FetchLike } from '../lib/http.js';
import type { ReadOnlyMssql } from '../lib/mssql.js';
import type { EnvLike } from '../lib/paths.js';
import { pinnedSha } from '../lib/pin.js';
import { readJson, stableStringify } from '../lib/report.js';
import { fetchLiveEntities, liveEntitiesSchema, liveEntitySchema } from './entities.js';
import { liveCheck } from './stored-procedures.js';
import { fetchLiveCatalog } from './tables.js';

/** File name of the live snapshot in the output directory. */
export const LIVE_SNAPSHOT_JSON = 'live-catalog.json';

/** Value of the snapshot's `generatedBy` field. */
export const LIVE_SNAPSHOT_GENERATED_BY = 'harness/src/inventory/live-snapshot.ts';

/** Live sources of a `--live` run; the caller owns and closes `db`. */
export interface LiveSources {
  origin: string;
  db: ReadOnlyMssql;
  fixturesLoaded: boolean;
  /** Source of the harness key the registration probe sends. */
  env: EnvLike;
  fetch?: FetchLike;
}

const count = z.int().nonnegative();

/** Schema of `live-catalog.json`; unknown keys are rejected. */
export const liveSnapshotSchema = z.strictObject({
  sourceSha: z.string().regex(/^[0-9a-f]{40}$/),
  generatedBy: z.literal(LIVE_SNAPSHOT_GENERATED_BY),
  fixturesLoaded: z.boolean(),
  entities: z.strictObject({ ...liveEntitiesSchema.shape, entities: z.array(z.strictObject(liveEntitySchema.shape)) }),
  catalog: z.array(
    z.strictObject({
      schema: z.string().min(1),
      name: z.string().min(1),
      columns: z.array(
        z.strictObject({
          name: z.string().min(1),
          type: z.string().min(1),
          length: z.union([count, z.literal('max')]).nullable(),
          nullable: z.boolean(),
        }),
      ),
      primaryKey: z.array(z.string().min(1)),
      hasPrimaryKey: z.boolean(),
      hasSiteId: z.boolean(),
    }),
  ),
  storedProcedures: z.strictObject({
    procedures: count,
    triggers: count,
    databaseTriggers: count,
    functions: count,
    total: count,
    excludedSchemas: z.array(z.string()),
    takenBeforeFixtures: z.boolean(),
    checkedAt: z.iso.datetime(),
    objects: z.array(
      z.strictObject({
        schema: z.string().nullable(),
        name: z.string(),
        kind: z.enum(['procedure', 'function', 'trigger', 'database-trigger']),
        objectType: z.string(),
      }),
    ),
  }),
});

/** A validated live snapshot. */
export type LiveSnapshot = z.infer<typeof liveSnapshotSchema>;

// The registration fields the inventory reads; the probe's others, such as the component's file on the host, are dropped.
const registration = z.object(liveEntitySchema.shape);

/** `snapshot` as `readLiveSnapshot` returns it once written, so a live run and its replay build from equal values. */
function normalise(snapshot: LiveSnapshot): LiveSnapshot {
  return liveSnapshotSchema.parse(JSON.parse(stableStringify(snapshot)));
}

/** Queries the registration probe, the catalog and the stored-procedure check, in that order, into a snapshot. */
export async function captureLiveSnapshot(sources: LiveSources): Promise<LiveSnapshot> {
  const probe = await fetchLiveEntities(sources.origin, { fetch: sources.fetch, env: sources.env });
  const catalog = await fetchLiveCatalog(sources.db);
  const storedProcedures = await liveCheck(sources.db, { fixturesLoaded: sources.fixturesLoaded });
  return normalise({
    sourceSha: pinnedSha(),
    generatedBy: LIVE_SNAPSHOT_GENERATED_BY,
    fixturesLoaded: sources.fixturesLoaded,
    entities: {
      generatedAt: probe.generatedAt,
      bundleableBeans: probe.bundleableBeans,
      versionedBeans: probe.versionedBeans,
      entities: probe.entities.map((e) => registration.parse(e)),
    },
    catalog,
    storedProcedures,
  });
}

/** The snapshot at `file`, validated and held to the pinned SHA; null when no file exists there. */
export async function readLiveSnapshot(file: string): Promise<LiveSnapshot | null> {
  if (!existsSync(file)) return null;
  const snapshot = await readJson(file, liveSnapshotSchema);
  const sha = pinnedSha();
  if (snapshot.sourceSha !== sha) throw new Error(`${file}: live snapshot sourceSha ${snapshot.sourceSha} differs from the pinned SHA ${sha}`);
  return snapshot;
}

/** Writes `snapshot` to `<outDir>/live-catalog.json` as stable JSON; returns the absolute path. */
export async function writeLiveSnapshot(snapshot: LiveSnapshot, outDir: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, LIVE_SNAPSHOT_JSON);
  await writeFile(file, stableStringify(snapshot), 'utf8');
  return file;
}
