// Loads and schema-validates the committed cut-over files, reads the inventory facts routing needs, and builds the routing index.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Ajv2020, type AnySchemaObject, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { ROUTE_FAMILIES, normaliseRouteKey } from '@opt2/platform/legacy-compat';
import type { GatewayPaths } from './paths.js';
import type {
  Authority,
  CsrfValidation,
  CutoverEntry,
  CutoverTable,
  DecisionListInput,
  Disposition,
  ExceptionEntry,
  ExceptionsDoc,
  GroupsFile,
  InventoryDoc,
  InventoryFacts,
  InventoryRouteKind,
  InventoryWritingItem,
  OwnershipDoc,
  ResponseMode,
  RouteFacts,
  RoutingIndex,
  SessionEffect,
  SourcePin,
  VariantsFile,
  WriterTrigger,
} from './types.js';

const REPORTED_ERRORS = 3;
const VERSION_FILE = /^v\d{4}\.json$/;
const LOGIN_ROUTE = normaliseRouteKey('admin:clogin.login');

/** Write unit the inventory records for Masa's file store. */
export const FILE_STORE = 'file-store';
// Masa's file store holds the bytes of tfiles rows (fileDAO.cfc:153-209), so its writes are writes of the tfiles units.
export const FILE_STORE_TABLE = 'tfiles';
/** Prefix of a write unit naming a decision-list or retired table, which has no target unit. */
export const DECISION_TABLE_PREFIX = 'legacy:';

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

// Schemas of the opt2 documents cover the fields the gateway reads; any other inventory metadata passes through.
const TEXT = { type: 'string' };
const NAME = { type: 'string', minLength: 1 };

const nullable = (schema: object): AnySchemaObject => ({ anyOf: [schema, { type: 'null' }] });
const arrayOf = (items: object): AnySchemaObject => ({ type: 'array', items });
const oneOfValues = (values: readonly string[]): AnySchemaObject => ({ type: 'string', enum: [...values] });

/** Schema of an object whose listed properties are all required except `optional`. */
function objectWith(properties: Record<string, object>, optional: readonly string[] = []): AnySchemaObject {
  return { type: 'object', required: Object.keys(properties).filter((key) => !optional.includes(key)), properties };
}

const DISPOSITIONS = ['retired', 'carry', 'legacy-served', 'decision'] satisfies Disposition[];
const SESSION_EFFECTS = ['none', 'login', 'logout', 'relogin'] satisfies SessionEffect[];
const CSRF_VALIDATIONS = ['validates', 'bypassed', 'none'] satisfies CsrfValidation[];
const RESPONSE_MODES = ['page', 'fragment', 'json', 'redirect', 'download'] satisfies ResponseMode[];
const WRITER_TRIGGERS = ['request', 'scheduler', 'thread', 'appstart'] satisfies WriterTrigger[];
const ROUTE_KINDS = [
  'api-family',
  'api-entity-method',
  'api-method',
  'oauth',
  'fixture',
  'job',
  'static',
  'soap',
] satisfies InventoryRouteKind[];
const EXCEPTION_DECISIONS = ['preserve', 'fix'] satisfies ExceptionEntry['decision'][];
const EXCEPTION_STATUSES = ['open', 'accepted', 'halted'] satisfies ExceptionEntry['status'][];

const SOURCE_REF = objectWith({
  path: NAME,
  lines: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'integer', minimum: 1 } },
});

const INVENTORY_WRITE = objectWith({
  unit: NAME,
  legacyTable: nullable(NAME),
  op: NAME,
  via: arrayOf(TEXT),
  source: SOURCE_REF,
  condition: nullable(TEXT),
  override: nullable(TEXT),
});

const CONDITIONAL_WRITE = objectWith({
  kind: NAME,
  unit: nullable(NAME),
  legacyTable: nullable(NAME),
  op: nullable(NAME),
  via: arrayOf(TEXT),
  source: SOURCE_REF,
  guard: TEXT,
});

const ITEM = { id: NAME, source: SOURCE_REF, owningService: nullable(NAME), disposition: oneOfValues(DISPOSITIONS) };
const WRITING_ITEM = { ...ITEM, writeSet: arrayOf(INVENTORY_WRITE), conditionalWrites: arrayOf(CONDITIONAL_WRITE) };
const ENTRY_POINT = {
  ...WRITING_ITEM,
  routeKey: NAME,
  // The inventory records `present` conditions that variants.json rewrites, so only the predicate's shape is checked.
  predicate: nullable(objectWith({ variant: NAME, when: arrayOf({ type: 'object' }) })),
  sessionEffects: oneOfValues(SESSION_EFFECTS),
};

const CSRF_FACTS = { csrfValidation: oneOfValues(CSRF_VALIDATIONS), csrfContext: nullable(TEXT) };

const ACTION_VARIANT = objectWith({
  ...ENTRY_POINT,
  ...CSRF_FACTS,
  responseMode: oneOfValues(RESPONSE_MODES),
  contentType: nullable(NAME),
});

// A route records CSRF facts exactly when it has a route key.
const ROUTE = {
  ...objectWith({
    ...ENTRY_POINT,
    routeKey: nullable(NAME),
    kind: oneOfValues(ROUTE_KINDS),
    family: oneOfValues(ROUTE_FAMILIES),
    csrfValidation: nullable(CSRF_FACTS.csrfValidation),
    csrfContext: CSRF_FACTS.csrfContext,
  }),
  if: { properties: { routeKey: { type: 'null' } } },
  then: { properties: { csrfValidation: { type: 'null' } } },
  else: { properties: { csrfValidation: { type: 'string' } } },
};

const CONTROLLER = objectWith({
  id: NAME,
  circuit: NAME,
  isBase: { type: 'boolean' },
  owningService: nullable(NAME),
  actions: arrayOf(objectWith({ id: NAME, action: NAME, variants: arrayOf(ACTION_VARIANT) })),
});

const WRITER = objectWith({
  component: NAME,
  method: NAME,
  source: SOURCE_REF,
  op: NAME,
  routeKeys: arrayOf(NAME),
  keyScope: arrayOf(NAME),
  trigger: oneOfValues(WRITER_TRIGGERS),
  sessionEffects: oneOfValues(SESSION_EFFECTS),
  condition: nullable(TEXT),
  override: nullable(TEXT),
});

const INVENTORY_FILE = objectWith({
  sourceSha: TEXT,
  controllers: arrayOf(CONTROLLER),
  routes: arrayOf(ROUTE),
  frontEnd: arrayOf(objectWith({ ...ENTRY_POINT, ...CSRF_FACTS })),
  scheduledJobs: arrayOf(
    objectWith({
      ...ITEM,
      routeKey: NAME,
      steps: arrayOf(objectWith({ ...WRITING_ITEM, order: { type: 'integer' }, step: NAME })),
    }),
  ),
  tables: arrayOf(
    objectWith({ ...ITEM, table: NAME, schema: NAME, hasPrimaryKey: nullable({ type: 'boolean' }), writers: arrayOf(WRITER) }),
  ),
});

const OWNERSHIP_FILE = objectWith({
  sourceSha: TEXT,
  units: arrayOf(objectWith({ unit: NAME, owner: NAME, legacyTables: arrayOf(NAME) })),
  tables: arrayOf(
    objectWith({
      table: NAME,
      owner: NAME,
      targets: arrayOf(objectWith({ unit: NAME, rowPredicate: nullable(TEXT), ownedColumns: arrayOf(NAME) })),
    }),
  ),
});

const ENTRY_POINT_REFS = arrayOf(objectWith({ routeKey: nullable(NAME) }));

const DECISION_LIST_FILE = objectWith({
  sourceSha: TEXT,
  tables: arrayOf(objectWith({ table: NAME, withheldEntryPoints: ENTRY_POINT_REFS }, ['withheldEntryPoints'])),
  actionVariants: arrayOf(objectWith({ routeKey: NAME, writeSet: arrayOf(NAME), entryPoints: ENTRY_POINT_REFS }, ['entryPoints'])),
});

const EXCEPTIONS_FILE = objectWith({
  sourceSha: TEXT,
  entries: arrayOf(
    objectWith(
      {
        id: NAME,
        routeKey: NAME,
        appliesTo: arrayOf(NAME),
        decision: oneOfValues(EXCEPTION_DECISIONS),
        status: oneOfValues(EXCEPTION_STATUSES),
      },
      ['appliesTo'],
    ),
  ),
});

// opt2/source-pin.json is exactly the five-field pin record.
const SOURCE_PIN_FILE = {
  ...objectWith({
    sha: { type: 'string', pattern: '^[0-9a-f]{40}$' },
    subject: NAME,
    repository: NAME,
    confirmedAt: NAME,
    confirmCommand: NAME,
  }),
  additionalProperties: false,
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

const opt2Validators = {
  inventory: ajv.compile<InventoryDoc>(INVENTORY_FILE),
  ownership: ajv.compile<OwnershipDoc>(OWNERSHIP_FILE),
  decisionList: ajv.compile<DecisionListInput>(DECISION_LIST_FILE),
  exceptions: ajv.compile<ExceptionsDoc>(EXCEPTIONS_FILE),
  pin: ajv.compile<SourcePin>(SOURCE_PIN_FILE),
};

/** A check a schema cannot express, as an instance path and its message. */
type Violation = readonly [instancePath: string, message: string];

/** Parses and schema-validates `text`, then rejects any violation `check` finds in the result. */
function parseValidated<T>(file: string, text: string, validate: ValidateFunction<T>, check: (value: T) => Violation[]): T {
  const value: unknown = JSON.parse(text);
  if (!validate(value)) throw new CutoverSchemaError(file, validate.errors ?? []);
  const violations = check(value);
  if (violations.length > 0) {
    const errors = violations.map(
      ([instancePath, message]): ErrorObject => ({ keyword: 'reference', instancePath, schemaPath: '#', params: {}, message }),
    );
    throw new CutoverSchemaError(file, errors);
  }
  return value;
}

async function readValidated<T>(file: string, validate: ValidateFunction<T>, check: (value: T) => Violation[] = () => []): Promise<T> {
  return parseValidated(file, await readFile(file, 'utf8'), validate, check);
}

/** The violation of a document whose `sourceSha` is not the pinned sha. */
function pinViolations(document: { readonly sourceSha: string }, pin: SourcePin): Violation[] {
  return document.sourceSha === pin.sha ? [] : [['/sourceSha', `must equal the pinned sha ${pin.sha}`]];
}

/** Duplicate ownership units and table targets naming no ownership unit. */
function ownershipViolations(ownership: OwnershipDoc): Violation[] {
  const units = new Set<string>();
  const violations: Violation[] = [];
  ownership.units.forEach(({ unit }, i) => {
    if (units.has(unit)) violations.push([`/units/${i}/unit`, `duplicates unit ${unit}`]);
    units.add(unit);
  });
  ownership.tables.forEach((table, i) => {
    table.targets.forEach(({ unit }, j) => {
      if (!units.has(unit)) violations.push([`/tables/${i}/targets/${j}/unit`, `unit ${unit} is not in /units`]);
    });
  });
  return violations;
}

/** Inventory writes whose unit is no ownership unit, no mapped file store and no decision-list table. */
function inventoryViolations(inventory: InventoryDoc, ownership: OwnershipDoc): Violation[] {
  const units = new Set(ownership.units.map((unit) => unit.unit));
  const fileStoreMapped = ownership.tables.some((table) => table.table.toLowerCase() === FILE_STORE_TABLE && table.targets.length > 0);
  const resolves = (unit: string): boolean =>
    units.has(unit) ||
    (unit === FILE_STORE && fileStoreMapped) ||
    (unit.startsWith(DECISION_TABLE_PREFIX) && unit.length > DECISION_TABLE_PREFIX.length);
  const items: Array<readonly [string, InventoryWritingItem]> = [
    ...inventory.controllers.flatMap((controller, i) =>
      controller.actions.flatMap((action, j) =>
        action.variants.map((variant, k) => [`/controllers/${i}/actions/${j}/variants/${k}`, variant] as const),
      ),
    ),
    ...inventory.routes.map((route, i) => [`/routes/${i}`, route] as const),
    ...inventory.frontEnd.map((entry, i) => [`/frontEnd/${i}`, entry] as const),
    ...inventory.scheduledJobs.flatMap((job, i) => job.steps.map((step, j) => [`/scheduledJobs/${i}/steps/${j}`, step] as const)),
  ];
  return items.flatMap(([path, item]) =>
    item.writeSet.flatMap((write, i): Violation[] =>
      resolves(write.unit) ? [] : [[`${path}/writeSet/${i}/unit`, `${write.unit} maps to no unit of opt2/table-ownership.json`]],
    ),
  );
}

/** Where groups.json fails to partition the ownership units into uniquely named groups with disjoint write entries. */
function partitionViolations(groupsFile: GroupsFile, ownership: OwnershipDoc): Violation[] {
  const owned = new Set(ownership.units.map((unit) => unit.unit));
  const ids = new Set<string>();
  const unitGroup = new Map<string, string>();
  const entryGroup = new Map<string, number>();
  const violations: Violation[] = [];
  groupsFile.groups.forEach((group, i) => {
    const at = `/groups/${i}`;
    if (ids.has(group.id)) violations.push([`${at}/id`, `duplicates group ${group.id}`]);
    ids.add(group.id);
    group.units.forEach((unit, j) => {
      const other = unitGroup.get(unit);
      if (!owned.has(unit)) violations.push([`${at}/units/${j}`, `unit ${unit} is not in opt2/table-ownership.json`]);
      else if (other !== undefined) violations.push([`${at}/units/${j}`, `unit ${unit} is also in ${other}`]);
      else unitGroup.set(unit, group.id);
    });
    const carries = group.writeEntries.length > 0;
    if (group.hasCarryWrite !== carries) {
      violations.push([`${at}/hasCarryWrite`, `must be ${carries} for ${group.writeEntries.length} write entries`]);
    }
    group.writeEntries.forEach((key, j) => {
      const route = normaliseRouteKey(key);
      const other = entryGroup.get(route);
      if (other === undefined) entryGroup.set(route, i);
      else if (other !== i) {
        violations.push([`${at}/writeEntries/${j}`, `${key} is also a write entry of ${groupsFile.groups[other]?.id}`]);
      }
    });
  });
  for (const unit of owned) if (!unitGroup.has(unit)) violations.push(['/groups', `ownership unit ${unit} is in no group`]);
  return violations;
}

/** Reads and validates `opt2/source-pin.json`: the five pin fields, with a 40-hex lower-case `sha`. */
export async function loadSourcePin(paths: Pick<GatewayPaths, 'sourcePinFile'>): Promise<SourcePin> {
  return readValidated(paths.sourcePinFile, opt2Validators.pin);
}

/** Validates table-ownership JSON read from `file`, bound to the pin; every target names a declared unit. */
export function parseTableOwnership(file: string, text: string, pin: SourcePin): OwnershipDoc {
  return parseValidated(file, text, opt2Validators.ownership, (doc) => [...pinViolations(doc, pin), ...ownershipViolations(doc)]);
}

/** Reads and validates `opt2/table-ownership.json` against the pin. */
export async function loadTableOwnership(paths: Pick<GatewayPaths, 'tableOwnershipFile' | 'sourcePinFile'>): Promise<OwnershipDoc> {
  const [pin, text] = await Promise.all([loadSourcePin(paths), readFile(paths.tableOwnershipFile, 'utf8')]);
  return parseTableOwnership(paths.tableOwnershipFile, text, pin);
}

/** Validates inventory JSON read from `file`, bound to the pin; every write unit resolves through `ownership`. */
export function parseInventory(file: string, text: string, pin: SourcePin, ownership: OwnershipDoc): InventoryDoc {
  return parseValidated(file, text, opt2Validators.inventory, (doc) => [
    ...pinViolations(doc, pin),
    ...inventoryViolations(doc, ownership),
  ]);
}

/** Reads and validates `opt2/inventory/legacy-inventory.json` against the pin and the table ownership. */
export async function loadInventory(
  paths: Pick<GatewayPaths, 'inventoryFile' | 'tableOwnershipFile' | 'sourcePinFile'>,
): Promise<InventoryDoc> {
  const [pin, ownership, text] = await Promise.all([
    loadSourcePin(paths),
    loadTableOwnership(paths),
    readFile(paths.inventoryFile, 'utf8'),
  ]);
  return parseInventory(paths.inventoryFile, text, pin, ownership);
}

/** Reads and validates `opt2/decision-list.json` against the pin. */
export async function loadDecisionList(paths: Pick<GatewayPaths, 'decisionListFile' | 'sourcePinFile'>): Promise<DecisionListInput> {
  const pin = await loadSourcePin(paths);
  return readValidated(paths.decisionListFile, opt2Validators.decisionList, (doc) => pinViolations(doc, pin));
}

/** Reads and validates `opt2/exceptions-list.json` against the pin. */
export async function loadExceptionsList(paths: Pick<GatewayPaths, 'exceptionsListFile' | 'sourcePinFile'>): Promise<ExceptionsDoc> {
  const pin = await loadSourcePin(paths);
  return readValidated(paths.exceptionsListFile, opt2Validators.exceptions, (doc) => pinViolations(doc, pin));
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

/** Reads and schema-validates `variants.json`, bound to the pin. */
export async function loadVariants(paths: Pick<GatewayPaths, 'variantsFile' | 'schemaFile' | 'sourcePinFile'>): Promise<VariantsFile> {
  const [{ variants }, pin] = await Promise.all([validatorsFor(paths.schemaFile), loadSourcePin(paths)]);
  return readValidated(paths.variantsFile, variants, (doc) => pinViolations(doc, pin));
}

/** Reads and schema-validates `groups.json`, bound to the pin; its groups must partition the ownership units. */
export async function loadGroups(
  paths: Pick<GatewayPaths, 'groupsFile' | 'schemaFile' | 'tableOwnershipFile' | 'sourcePinFile'>,
): Promise<GroupsFile> {
  const [{ groups }, pin, ownership] = await Promise.all([
    validatorsFor(paths.schemaFile),
    loadSourcePin(paths),
    loadTableOwnership(paths),
  ]);
  return readValidated(paths.groupsFile, groups, (doc) => [...pinViolations(doc, pin), ...partitionViolations(doc, ownership)]);
}

/** CSRF fact of a key no inventory item records one for, as csrf.ts treats an unlisted key. */
const UNRECORDED_VALIDATION: CsrfValidation = 'validates';

/** Precedence of CSRF facts recorded for one key by several items. */
const CSRF_STRENGTH: Record<CsrfValidation, number> = { none: 0, bypassed: 1, validates: 2 };

type CollectedFacts = Omit<RouteFacts, 'csrfValidation' | 'csrfContext' | 'writeSet' | 'keyScope' | 'sessionEffects'> & {
  csrf?: Pick<RouteFacts, 'csrfValidation' | 'csrfContext'>;
  writeSet: Set<string>;
  keyScope: Set<string>;
  sessionEffects: Set<SessionEffect>;
};

/** Route facts per inventoried key, unioned over the entry points and table writers that carry it; the strongest CSRF fact wins. */
export async function loadInventoryFacts(
  paths: Pick<GatewayPaths, 'inventoryFile' | 'tableOwnershipFile' | 'sourcePinFile'>,
): Promise<InventoryFacts> {
  const inventory = await loadInventory(paths);
  const collected = new Map<string, CollectedFacts>();
  const factsFor = (routeKey: string): CollectedFacts => {
    const route = normaliseRouteKey(routeKey);
    let facts = collected.get(route);
    if (facts === undefined) {
      facts = { route, writeSet: new Set(), keyScope: new Set(), sessionEffects: new Set() };
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
    // The schema makes csrfValidation null only on items without a route key.
    const csrfValidation = item.csrfValidation ?? UNRECORDED_VALIDATION;
    if (facts.csrf === undefined || CSRF_STRENGTH[csrfValidation] > CSRF_STRENGTH[facts.csrf.csrfValidation]) {
      facts.csrf = item.csrfContext === null ? { csrfValidation } : { csrfValidation, csrfContext: item.csrfContext };
    }
  }
  for (const variant of actionVariants) {
    const facts = factsFor(variant.routeKey);
    facts.responseMode = variant.responseMode;
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
      .map(([route, { csrf = { csrfValidation: UNRECORDED_VALIDATION }, ...facts }]) => [
        route,
        {
          ...facts,
          ...csrf,
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
 * Throws when a route, a unit or the login write entry would resolve to more than one entry or group.
 */
export function buildRoutingIndex(table: CutoverTable, _variants: VariantsFile, groups: GroupsFile): RoutingIndex {
  const entries = new Map<string, CutoverEntry>();
  for (const entry of table.entries) {
    const route = normaliseRouteKey(entry.route);
    const other = entries.get(route);
    if (other !== undefined) throw new Error(`${table.tableVersion}: entries ${other.route} and ${entry.route} both route ${route}`);
    entries.set(route, entry);
  }
  const matchKeys: readonly string[] = Object.freeze([...entries.keys()]);
  const authorities = new Map<string, Authority>(Object.entries(table.groupAuthority));
  const unitGroups = new Map<string, string>();
  for (const group of groups.groups) {
    for (const unit of group.units) {
      const other = unitGroups.get(unit);
      if (other !== undefined) throw new Error(`groups.json: unit ${unit} is in both ${other} and ${group.id}`);
      unitGroups.set(unit, group.id);
    }
  }
  const groupAuthority = (groupId: string): Authority => authorities.get(groupId) ?? 'legacy';
  const entryFor = (routeKey: string): CutoverEntry | undefined => entries.get(normaliseRouteKey(routeKey));
  const loginGroups = groups.groups.filter((group) => group.writeEntries.some((key) => normaliseRouteKey(key) === LOGIN_ROUTE));
  if (loginGroups.length > 1) {
    throw new Error(`groups.json: ${LOGIN_ROUTE} is a write entry of ${loginGroups.map((group) => group.id).join(' and ')}`);
  }
  const loginGroup = loginGroups[0];
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
