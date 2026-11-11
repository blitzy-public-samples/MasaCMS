// Loads and schema-validates the committed cut-over files, reads the inventory facts routing needs, and builds the routing index.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Ajv2020, type AnySchemaObject, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { normaliseRouteKey } from '@opt2/platform/legacy-compat';
import type { GatewayPaths } from './paths.js';
import type {
  Authority,
  CutoverEntry,
  CutoverTable,
  GroupsFile,
  InventoryDoc,
  InventoryFacts,
  RouteFacts,
  RoutingIndex,
  SessionEffect,
  VariantsFile,
} from './types.js';

const REPORTED_ERRORS = 3;
const VERSION_FILE = /^v\d{4}\.json$/;
const LOGIN_ROUTE = normaliseRouteKey('admin:clogin.login');

function describeError(error: ErrorObject): string {
  return `${error.instancePath || '/'} ${error.message ?? error.keyword}`;
}

/** A cut-over file that does not match its JSON Schema; the message names the file and the first error paths. */
export class CutoverSchemaError extends Error {
  override readonly name = 'CutoverSchemaError';

  constructor(
    readonly file: string,
    readonly errors: ErrorObject[],
  ) {
    super(`${file} does not match its cut-over schema: ${errors.slice(0, REPORTED_ERRORS).map(describeError).join('; ')}`);
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: true });

/** Schema of a `{ param, <key> }` variant condition. */
function paramCondition(key: string, value: object): object {
  return {
    type: 'object',
    required: ['param', key],
    additionalProperties: false,
    properties: { param: { type: 'string', minLength: 1 }, [key]: value },
  };
}

/** Schema of a single-keyword variant condition. */
function keywordCondition(key: string, value: object): object {
  return { type: 'object', required: [key], additionalProperties: false, properties: { [key]: value } };
}

// `VariantCondition` of @opt2/platform/legacy-compat; the schema file defines none for variants.json or groups.json.
const VARIANT_CONDITION = {
  type: 'object',
  oneOf: [
    paramCondition('equals', { type: 'string' }),
    paramCondition('in', { type: 'array', minItems: 1, items: { type: 'string' } }),
    paramCondition('nonEmpty', { const: true }),
    paramCondition('truthy', { const: true }),
    keywordCondition('multipartExtensionIn', { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } }),
    keywordCondition('anyOf', { type: 'array', minItems: 1, items: { $ref: '#/$defs/variantCondition' } }),
    keywordCondition('not', { $ref: '#/$defs/variantCondition' }),
  ],
};

const VARIANTS_FILE = {
  type: 'object',
  required: ['sourceSha', 'variants'],
  additionalProperties: false,
  properties: {
    sourceSha: { $ref: '#/$defs/sourceSha' },
    variants: {
      type: 'array',
      items: {
        type: 'object',
        required: ['route', 'variant', 'when'],
        additionalProperties: false,
        properties: {
          route: { $ref: '#/$defs/routeKey' },
          variant: { type: 'string', minLength: 1 },
          when: { type: 'array', items: { $ref: '#/$defs/variantCondition' } },
        },
      },
    },
  },
};

const SHA256 = { type: 'string', pattern: '^[0-9a-f]{64}$' };

const GROUPS_FILE = {
  type: 'object',
  required: ['sourceSha', 'generatedBy', 'inputs', 'groups'],
  additionalProperties: false,
  properties: {
    sourceSha: { $ref: '#/$defs/sourceSha' },
    generatedBy: { type: 'string', minLength: 1 },
    inputs: {
      type: 'object',
      required: ['inventorySha256', 'tableOwnershipSha256'],
      additionalProperties: false,
      properties: { inventorySha256: SHA256, tableOwnershipSha256: SHA256 },
    },
    groups: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'units', 'writeEntries', 'hasCarryWrite'],
        additionalProperties: false,
        properties: {
          id: { $ref: '#/$defs/groupId' },
          units: { type: 'array', minItems: 1, uniqueItems: true, items: { $ref: '#/$defs/unitId' } },
          writeEntries: { type: 'array', uniqueItems: true, items: { $ref: '#/$defs/routeKey' } },
          hasCarryWrite: { type: 'boolean' },
        },
      },
    },
  },
};

interface Validators {
  version: ValidateFunction<CutoverTable>;
  variants: ValidateFunction<VariantsFile>;
  groups: ValidateFunction<GroupsFile>;
}

const validatorsBySchemaFile = new Map<string, Promise<Validators>>();

/** Compiles one schema file; its `$defs` and `sourceSha` rule also constrain the ids in variants.json and groups.json. */
async function compileValidators(schemaFile: string): Promise<Validators> {
  const version = JSON.parse(await readFile(schemaFile, 'utf8')) as AnySchemaObject;
  // Copies of the schema (OPT2_CUTOVER_DIR) share one `$id`; without it every copy compiles beside the others in the one Ajv instance.
  delete version.$id;
  const $defs = { ...version.$defs, sourceSha: version.properties.sourceSha, variantCondition: VARIANT_CONDITION };
  return {
    version: ajv.compile<CutoverTable>(version),
    variants: ajv.compile<VariantsFile>({ ...VARIANTS_FILE, $defs }),
    groups: ajv.compile<GroupsFile>({ ...GROUPS_FILE, $defs }),
  };
}

/** The validators of a schema file, compiled on first use. */
function validatorsFor(schemaFile: string): Promise<Validators> {
  let validators = validatorsBySchemaFile.get(schemaFile);
  if (validators === undefined) {
    validators = compileValidators(schemaFile);
    validatorsBySchemaFile.set(schemaFile, validators);
    validators.catch(() => validatorsBySchemaFile.delete(schemaFile));
  }
  return validators;
}

async function readValidated<T>(file: string, validate: ValidateFunction<T>): Promise<T> {
  const value: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!validate(value)) throw new CutoverSchemaError(file, validate.errors ?? []);
  return value;
}

/** Reads and schema-validates `versions/<tableVersion>.json`; a missing file rejects with ENOENT. */
export async function loadVersion(
  paths: Pick<GatewayPaths, 'versionsDir' | 'schemaFile'>,
  tableVersion: string,
): Promise<CutoverTable> {
  const { version } = await validatorsFor(paths.schemaFile);
  return readValidated(join(paths.versionsDir, `${tableVersion}.json`), version);
}

/** Ids of the committed version files (`vNNNN`), sorted. */
export async function listVersions(paths: Pick<GatewayPaths, 'versionsDir'>): Promise<string[]> {
  const names = await readdir(paths.versionsDir);
  return names
    .filter((name) => VERSION_FILE.test(name))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
}

/** Reads and schema-validates `variants.json`. */
export async function loadVariants(paths: Pick<GatewayPaths, 'variantsFile' | 'schemaFile'>): Promise<VariantsFile> {
  const { variants } = await validatorsFor(paths.schemaFile);
  return readValidated(paths.variantsFile, variants);
}

/** Reads and schema-validates `groups.json`. */
export async function loadGroups(paths: Pick<GatewayPaths, 'groupsFile' | 'schemaFile'>): Promise<GroupsFile> {
  const { groups } = await validatorsFor(paths.schemaFile);
  return readValidated(paths.groupsFile, groups);
}

type CollectedFacts = Omit<RouteFacts, 'writeSet' | 'keyScope' | 'sessionEffects'> & {
  writeSet: Set<string>;
  keyScope: Set<string>;
  sessionEffects: Set<SessionEffect>;
};

/** Route facts per inventoried key, unioned over the entry points and table writers that carry it. */
export async function loadInventoryFacts(paths: Pick<GatewayPaths, 'inventoryFile'>): Promise<InventoryFacts> {
  const inventory = JSON.parse(await readFile(paths.inventoryFile, 'utf8')) as InventoryDoc;
  const collected = new Map<string, CollectedFacts>();
  const factsFor = (routeKey: string): CollectedFacts => {
    const route = normaliseRouteKey(routeKey);
    let facts = collected.get(route);
    if (facts === undefined) {
      facts = { route, csrfValidation: 'none', writeSet: new Set(), keyScope: new Set(), sessionEffects: new Set() };
      collected.set(route, facts);
    }
    return facts;
  };

  const actionVariants = inventory.controllers.flatMap((controller) => controller.actions.flatMap((action) => action.variants));
  for (const item of [...actionVariants, ...inventory.routes, ...inventory.frontEnd]) {
    if (item.routeKey === null) continue;
    const facts = factsFor(item.routeKey);
    for (const write of item.writeSet) facts.writeSet.add(write.unit);
    // An entry point's own effect counts too: logout is recorded on entry points, not on the table writers they reach.
    facts.sessionEffects.add(item.sessionEffects);
  }
  for (const variant of actionVariants) {
    const facts = factsFor(variant.routeKey);
    facts.csrfValidation = variant.csrfValidation;
    facts.responseMode = variant.responseMode;
    if (variant.csrfContext !== null) facts.csrfContext = variant.csrfContext;
    if (variant.contentType !== null) facts.contentType = variant.contentType;
  }
  for (const table of inventory.tables) {
    for (const writer of table.writers) {
      for (const routeKey of writer.routeKeys) {
        const facts = factsFor(routeKey);
        for (const scope of writer.keyScope) facts.keyScope.add(scope);
        facts.sessionEffects.add(writer.sessionEffects);
      }
    }
  }

  const byRoute = new Map<string, RouteFacts>(
    [...collected.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([route, facts]) => [
        route,
        {
          ...facts,
          writeSet: [...facts.writeSet].sort(),
          keyScope: [...facts.keyScope].sort(),
          sessionEffects: [...facts.sessionEffects].sort(),
        },
      ]),
  );
  return {
    get: (routeKey) => byRoute.get(normaliseRouteKey(routeKey)),
    routes: () => [...byRoute.keys()],
  };
}

/**
 * Indexes a cut-over version by normalised route and maps each unit to its generated group's authority.
 * `_variants` keeps the shared call shape: `matchRouteKey` matches computed keys without variant declarations.
 */
export function buildRoutingIndex(table: CutoverTable, _variants: VariantsFile, groups: GroupsFile): RoutingIndex {
  const entries = new Map<string, CutoverEntry>(table.entries.map((entry) => [normaliseRouteKey(entry.route), entry]));
  const matchKeys: readonly string[] = Object.freeze([...entries.keys()]);
  const authorities = new Map<string, Authority>(Object.entries(table.groupAuthority));
  const unitGroups = new Map<string, string>(
    groups.groups.flatMap((group) => group.units.map((unit): [string, string] => [unit, group.id])),
  );
  const groupAuthority = (groupId: string): Authority => authorities.get(groupId) ?? 'legacy';
  const entryFor = (routeKey: string): CutoverEntry | undefined => entries.get(normaliseRouteKey(routeKey));
  const loginGroup = groups.groups.find((group) => group.writeEntries.some((key) => normaliseRouteKey(key) === LOGIN_ROUTE));
  const loginAuthority = loginGroup === undefined ? 'legacy' : groupAuthority(loginGroup.id);

  return {
    table,
    matchKeys,
    entryFor,
    unitAuthority: (unit) => {
      const group = unitGroups.get(unit);
      return group === undefined ? 'legacy' : groupAuthority(group);
    },
    groupOf: (routeKey) => entryFor(routeKey)?.group ?? undefined,
    groupAuthority,
    loginGroupAuthority: () => loginAuthority,
  };
}
