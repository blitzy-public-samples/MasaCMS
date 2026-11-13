/** Fixture capability of the legacy side and the ownership file's fixture tables, which reconciliation skips when absent. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { z, type Clock } from '@opt2/platform/service-kit';

import { UnitCatalogError } from '../owners/index.js';

/** `${OPT2_STATE_DIR}/fixtures.json` as `legacy-fixtures/load-fixtures.sh` writes it. */
const fixtureStatusSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  checkedAt: z.string().min(1),
});

/** Whether the legacy fixtures are loaded, and why not. */
export type FixtureStatus = z.infer<typeof fixtureStatusSchema>;

/** `fixtures.json` cannot be read or does not match its schema. */
export class FixtureStatusError extends Error {
  override readonly name = 'FixtureStatusError';
}

/** The ownership file's tables with their origin, which the unit catalog does not keep. */
const tableOriginsSchema = z.object({
  tables: z.array(z.object({ table: z.string().min(1), origin: z.string().optional() })),
});

const FIXTURE_STATUS_FILE = 'fixtures.json';
const FIXTURE_ORIGIN = 'fixture';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function issuesOf(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

/** Lookup form of a legacy table name: no leading `dbo.`, lower case, as the unit catalog compares names. */
export function tableLookupKey(table: string): string {
  return table.replace(/^dbo\./i, '').toLowerCase();
}

/**
 * Fixture status recorded in `stateDir`; a missing `fixtures.json` reads as unavailable, checked at `clock`'s now.
 * @throws FixtureStatusError when the file cannot be read, is not JSON or does not match its schema.
 */
export async function readFixtureStatus(stateDir: string, clock: Clock): Promise<FixtureStatus> {
  const file = path.join(stateDir, FIXTURE_STATUS_FILE);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { available: false, reason: `${FIXTURE_STATUS_FILE} not found`, checkedAt: clock.now().toISOString() };
    }
    throw new FixtureStatusError(`fixture status ${file} cannot be read: ${messageOf(error)}`, { cause: error });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new FixtureStatusError(`fixture status ${file} is not valid JSON: ${messageOf(error)}`, { cause: error });
  }
  const parsed = fixtureStatusSchema.safeParse(json);
  if (!parsed.success) throw new FixtureStatusError(`fixture status ${file} is invalid: ${issuesOf(parsed.error)}`, { cause: parsed.error });
  return parsed.data;
}

/**
 * Lookup keys of the tables `tableOwnershipPath` records with `origin: "fixture"`.
 * @throws UnitCatalogError when the file cannot be read or lacks its table list.
 */
export async function fixtureTables(tableOwnershipPath: string): Promise<ReadonlySet<string>> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(tableOwnershipPath, 'utf8'));
  } catch (error) {
    throw new UnitCatalogError(`table ownership file ${tableOwnershipPath} cannot be read as JSON: ${messageOf(error)}`, { cause: error });
  }
  const parsed = tableOriginsSchema.safeParse(json);
  if (!parsed.success) {
    throw new UnitCatalogError(`table ownership file ${tableOwnershipPath} is invalid: ${issuesOf(parsed.error)}`, { cause: parsed.error });
  }
  return new Set(parsed.data.tables.filter((entry) => entry.origin === FIXTURE_ORIGIN).map((entry) => tableLookupKey(entry.table)));
}
