// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { sha256Hex } from './bytes.js';
import type { SeedConfig } from './config.js';
import { emptyFixtureTables, type FixtureContext, type FixtureModule, type FixtureTables } from './fixture-tables.js';
import { buildCommunicationsFixtures } from './fixtures/communications.js';
import { buildEsignatureFixtures } from './fixtures/esignature.js';
import { buildFinanceFixtures } from './fixtures/finance.js';
import { buildPeopleFixtures } from './fixtures/people.js';
import { buildReportingFixtures } from './fixtures/reporting.js';
import { buildSurveyFixtures } from './fixtures/surveys.js';
import { buildTimesheetFixtures } from './fixtures/timesheets.js';
import { buildMasa, indexMasa, type MasaData } from './masa.js';
import { createRandom } from './random.js';
import { createCalendar } from './time.js';

/** Generated dataset; `digest` covers `seed`, `businessDate`, `masa` and `fixtures`, never `sourceSha`. */
export interface Dataset {
  sourceSha: string;
  seed: number;
  businessDate: string;
  digest: string;
  masa: MasaData;
  fixtures: FixtureTables;
}

type FixtureBuilder = (ctx: FixtureContext) => FixtureTables;

/** Fixture builders in generation order. */
const FIXTURE_BUILDERS: readonly (readonly [FixtureModule, FixtureBuilder])[] = Object.freeze([
  ['people', buildPeopleFixtures],
  ['timesheets', buildTimesheetFixtures],
  ['finance', buildFinanceFixtures],
  ['surveys', buildSurveyFixtures],
  ['reporting', buildReportingFixtures],
  ['communications', buildCommunicationsFixtures],
  ['esignature', buildEsignatureFixtures],
] as const);

type PathSegment = string | number;

function pointer(path: readonly PathSegment[]): string {
  return `$${path.map((segment) => `[${JSON.stringify(segment)}]`).join('')}`;
}

function kindOf(value: unknown): string {
  if (typeof value === 'number') return `number ${value}`;
  if (typeof value === 'object') return `object ${Object.prototype.toString.call(value)}`;
  return typeof value;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function encode(value: unknown, path: PathSegment[]): string {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (Number.isFinite(value)) return JSON.stringify(value);
      break;
    case 'object': {
      if (value === null) return 'null';
      const parts: string[] = [];
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i += 1) {
          path.push(i);
          parts.push(encode(value[i], path));
          path.pop();
        }
        return `[${parts.join(',')}]`;
      }
      if (!isPlainObject(value)) break;
      for (const key of Object.keys(value).sort()) {
        path.push(key);
        parts.push(`${JSON.stringify(key)}:${encode(value[key], path)}`);
        path.pop();
      }
      return `{${parts.join(',')}}`;
    }
    default:
      break;
  }
  throw new TypeError(`canonicalJson: cannot encode ${kindOf(value)} at ${pointer(path)}`);
}

/** Compact JSON with keys sorted by UTF-16 code unit; throws `TypeError` for what a JSON round trip alters (undefined, functions, symbols, bigints, non-finite numbers, non-plain objects). */
export function canonicalJson(value: unknown): string {
  return encode(value, []);
}

/** Lowercase hex SHA-256 of the canonical JSON of `{ seed, businessDate, masa, fixtures }`. */
export function datasetDigest(d: Pick<Dataset, 'seed' | 'businessDate' | 'masa' | 'fixtures'>): string {
  const { seed, businessDate, masa, fixtures } = d;
  return sha256Hex(canonicalJson({ seed, businessDate, masa, fixtures }));
}

/** Generates the dataset for `config`, recording `sourceSha`; equal config and `sourceSha` yield identical datasets, and the digest depends on `config` alone. */
export function buildDataset(config: SeedConfig, sourceSha: string): Dataset {
  const { seed, businessDate } = config;
  const random = createRandom(seed);
  const calendar = createCalendar(businessDate);
  const masa = buildMasa(config, random.fork('masa'), calendar);
  const index = indexMasa(masa, config);
  const fixtures = emptyFixtureTables(config);
  const filled = new Set<string>();
  for (const [module, build] of FIXTURE_BUILDERS) {
    const tables = build({ config, random: random.fork(`fixtures/${module}`), calendar, masa, index });
    for (const [key, rows] of Object.entries(tables)) {
      if (!Object.hasOwn(fixtures, key)) {
        throw new RangeError(`fixtures/${module} returned unknown fixture key ${JSON.stringify(key)}`);
      }
      if (filled.has(key)) throw new Error(`fixtures/${module} returned fixture key ${JSON.stringify(key)} already filled`);
      filled.add(key);
      fixtures[key] = rows;
    }
  }
  return { sourceSha, seed, businessDate, digest: datasetDigest({ seed, businessDate, masa, fixtures }), masa, fixtures };
}
