// Entity inventory: ORM and domain-bean component declarations at the pin, plus live `application.objectMappings` registrations.
import { closeSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import { z } from '@opt2/platform/service-kit';
import { createHttpSession, type FetchLike } from '../lib/http.js';
import {
  computeClosure,
  extractCalls,
  lineOf,
  parseAttributes,
  parseCfmlComponent,
  resolveComponentPath,
  type CfmlComponent,
  type CfmlFunction,
  type ClosureContext,
  type SourceTree,
} from './closure.js';

/** Directory the static scan walks. */
export const ENTITY_SCAN_ROOT = 'core/mura';

/** Dotted name of the class every ORM entity extends, directly or through a base. */
export const ORM_ROOT = 'mura.bean.beanORM';

/** Archive path of {@link ORM_ROOT}. */
export const ORM_ROOT_PATH = 'core/mura/bean/beanORM.cfc';

/** Path of the live registration probe; the query is `info=entities`. */
export const LIVE_ENTITIES_PATH = '/harness/legacy-baseline/cfml/run.cfm';

/** Source of a live registration that has no declaration in the tree. */
export const LIVE_SOURCE: EntitySource = { path: 'live:application.objectMappings', lines: [0, 0] };

/** Reason recorded on a component whose only ORM link is ORM component source held as text. */
export const NOT_ENTITY_REASON = 'beanORM text is generated component source';

/** Inventory class of an entity entry. */
export type EntityClass = 'orm-base' | 'orm-concrete' | 'not-entity' | 'dynamic' | 'domain-bean';

/** Where a live registration comes from, as the probe classifies it. */
export type LiveOrigin = 'formBuilder' | 'dynamic' | 'plugin' | 'core' | 'other';

/** Repository-relative file and 1-based line span; `[0, 0]` for {@link LIVE_SOURCE}. */
export interface EntitySource {
  path: string;
  lines: [number, number];
}

/** How `writesTables` was derived. */
export type WritesBasis = 'orm-table' | 'bean-save' | 'dao-methods';

/** One entity fact record; owners and dispositions are added by `generate.ts`. */
export interface EntityEntry {
  id: string;
  class: EntityClass;
  source: EntitySource;
  /** Dotted component name (`mura.user.userBean`), the declaring file's for a pattern; null when a registration has none. */
  component: string | null;
  /** Declared `extends`, as written. */
  extends: string | null;
  /** Whether the file starts with a UTF-8 byte-order mark; null when unknown (in-memory tree, live, pattern). */
  bom: boolean | null;
  /** True for the declaration site of a family of dynamic entities. */
  pattern: boolean;
  /** Lower-cased mapped table (declared, or live for dynamic instances). */
  table: string | null;
  /** Declared `entityname` attribute, as written. */
  entityname: string | null;
  /** Key the component registers under in `application.objectMappings`. */
  registeredName: string | null;
  bundleable: string | null;
  versioned: string | null;
  historical: string | null;
  reason: string | null;
  /** Lines holding ORM component source as text (not-entity only). */
  beanORMTextLines: number[] | null;
  /** Live origin a dynamic entry stands for. */
  origin: LiveOrigin | null;
  /** Pattern entry a dynamic instance belongs to. */
  patternId: string | null;
  /** Component that persists a domain bean. */
  dao: string | null;
  writesTables: string[] | null;
  writesBasis: WritesBasis | null;
  liveRegistered: boolean | null;
  /** Registration names matched to this entry, sorted. */
  liveNames: string[] | null;
  liveInstances: number | null;
  liveStatus: 'live' | 'pending-run';
}

/** Per-class counts; `dynamic` is null until live data is merged. */
export interface EntityClassCounts {
  ormBase: number;
  ormConcrete: number;
  notEntity: number;
  domainBean: number;
  dynamic: number | null;
  dynamicPatterns: number;
}

/** ORM lookups for `ComponentIndex.ormTable` and entity-name resolution. */
export interface OrmEntityIndex {
  /** Component path of a concrete ORM entity → its lower-cased table. */
  byComponent: Map<string, string>;
  /** Lower-cased registered entity name → component path. */
  byEntityName: Map<string, string>;
}

/** Result of {@link extractEntities}. */
export interface EntityExtraction {
  entities: EntityEntry[];
  /** Sorted, unique, lower-cased tables of the concrete ORM entities. */
  ormTables: string[];
  ormIndex: OrmEntityIndex;
  counts: EntityClassCounts;
}

const liveFlag = z.boolean().nullable();

/** One registration of the `?info=entities` probe; fields this module does not read pass through. */
export const liveEntitySchema = z.looseObject({
  name: z.string().min(1),
  table: z.string().nullable(),
  componentPath: z.string().nullable(),
  versioned: liveFlag,
  bundleable: liveFlag,
  historical: liveFlag,
  registrationComplete: z.boolean(),
  origin: z.enum(['formBuilder', 'dynamic', 'plugin', 'core', 'other']),
});

/** Payload of `run.cfm?info=entities`. */
export const liveEntitiesSchema = z.looseObject({
  generatedAt: z.string(),
  bundleableBeans: z.array(z.string()),
  versionedBeans: z.array(z.string()),
  entities: z.array(liveEntitySchema),
});

/** A validated live registration. */
export type LiveEntity = z.infer<typeof liveEntitySchema>;

/** A validated live probe payload. */
export type LiveEntities = z.infer<typeof liveEntitiesSchema>;

/** Injectable transport for {@link fetchLiveEntities}. */
export interface FetchLiveEntitiesDeps {
  fetch?: FetchLike;
  timeoutMs?: number;
}

// Declaration sites of the dynamic entity families. The ids are the ones the committed traceability tables cite;
// live instances are separate `dynamic` entries that point back here through `patternId`.
const FORM_BUILDER_PATTERN = {
  id: 'ent:dyn:fb_*',
  origin: 'formBuilder',
  reason: 'form-builder fb_* entities generated from component source',
} as const;
const FUNCTION_PATTERNS = [
  {
    id: 'ent:dyn:tentity-declared',
    origin: 'dynamic',
    component: 'core/mura/client/api/json/v1/jsonApiUtility.cfc',
    method: 'declareEntity',
    reason: 'tentity JSON entities declared through the JSON API',
  },
  {
    id: 'ent:dyn:plugin-declared',
    origin: 'plugin',
    component: 'core/mura/plugin/pluginConfig.cfc',
    method: 'registerBeanDir',
    reason: 'entities registered from plugin bean directories',
  },
] as const;

const GENERATED_DECLARATION = /\bcomponent\s+extends\s*=\s*(["']{1,2})([A-Za-z_$][\w$.]*)\1/gi;
const WRITE_VERB = /^(save|create|update|insert|add|delete)/i;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byId(a: EntityEntry, b: EntityEntry): number {
  return compareText(a.id, b.id);
}

function baseName(p: string): string {
  return path.posix.basename(p, path.posix.extname(p));
}

/** `core/mura/a/b.cfc` → `mura.a.b`. */
function dottedName(p: string): string {
  return `mura.${p.slice(ENTITY_SCAN_ROOT.length + 1, -'.cfc'.length).split('/').join('.')}`;
}

/** Lower-cased dotted name with the `muraWRM.core.mura.` mapping folded onto `mura.`. */
function dottedKey(name: string): string {
  const lower = name.trim().toLowerCase();
  return lower.startsWith('murawrm.core.mura.') ? `mura.${lower.slice('murawrm.core.mura.'.length)}` : lower;
}

/** Name `bean.cfc` gives the entity in `getEntityName()`: `entityname`'s last segment, else the file name less `Bean`. */
function registeredNameOf(entityname: string | undefined, base: string): string {
  const declared = entityname?.split('.').filter((s) => s !== '').pop();
  if (declared !== undefined) return declared;
  const lower = base.toLowerCase();
  return lower !== 'bean' && lower.endsWith('bean') ? base.slice(0, -4) : base;
}

function attrOrNull(attrs: Record<string, string>, name: string): string | null {
  const value = attrs[name];
  return value === undefined || value === '' ? null : value;
}

function hasBom(tree: SourceTree, rel: string): boolean | null {
  if (tree.root === null) return null;
  const fd = openSync(path.join(tree.root, rel), 'r');
  try {
    const head = Buffer.alloc(3);
    return readSync(fd, head, 0, 3, 0) === 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf;
  } finally {
    closeSync(fd);
  }
}

/** Resolves an `extends` value: exact as CFML does, then case-insensitively among the scanned components. */
function extendsResolver(tree: SourceTree, files: readonly string[]): (name: string, from: string) => string | null {
  const byDotted = new Map(files.map((f) => [dottedName(f).toLowerCase(), f]));
  return (name, from) => resolveComponentPath(name, from, tree) ?? byDotted.get(dottedKey(name)) ?? null;
}

/** Whether an `extends` value written in `from` reaches {@link ORM_ROOT}. */
function ormTest(
  parsed: ReadonlyMap<string, CfmlComponent>,
  resolve: (name: string, from: string) => string | null,
): (value: string, from: string) => boolean {
  const memo = new Map<string, boolean>();
  const reaches = (value: string, from: string, seen: Set<string>): boolean => {
    if (dottedKey(value) === ORM_ROOT.toLowerCase()) return true;
    const parent = resolve(value, from);
    if (parent === null) return false;
    if (parent === ORM_ROOT_PATH) return true;
    const cached = memo.get(parent);
    if (cached !== undefined) return cached;
    if (seen.has(parent)) return false;
    seen.add(parent);
    const ext = parsed.get(parent)?.declaration.attrs.extends;
    const result = ext !== undefined && ext !== '' && reaches(ext, parent, seen);
    memo.set(parent, result);
    return result;
  };
  return (value, from) => reaches(value, from, new Set([from]));
}

interface GeneratedDeclaration {
  line: number;
  table: string | null;
}

/** ORM component declarations held as text: in comment-stripped source, one past the component's own declaration is literal. */
function generatedOrmDeclarations(
  comp: CfmlComponent,
  isOrm: (value: string, from: string) => boolean,
): GeneratedDeclaration[] {
  const out: GeneratedDeclaration[] = [];
  for (const m of comp.text.matchAll(GENERATED_DECLARATION)) {
    const line = lineOf(comp.text, m.index);
    const extendsName = m[2];
    if (line <= comp.declaration.endLine || extendsName === undefined || !isOrm(extendsName, comp.path)) continue;
    const stops = [comp.text.indexOf('{', m.index), comp.text.indexOf('\n', m.index)].filter((i) => i >= 0);
    const end = stops.length === 0 ? comp.text.length : Math.min(...stops);
    const table = parseAttributes(comp.text.slice(m.index + 'component'.length, end)).table;
    out.push({ line, table: table === undefined || table === '' ? null : table });
  }
  return out;
}

const PENDING_LIVE = { liveRegistered: null, liveNames: null, liveInstances: null, liveStatus: 'pending-run' } as const;

/** An entry with every fact not given set to null and live fields pending. */
function entry(fields: Pick<EntityEntry, 'id' | 'class' | 'source'> & Partial<EntityEntry>): EntityEntry {
  return {
    component: null,
    extends: null,
    bom: null,
    pattern: false,
    table: null,
    entityname: null,
    registeredName: null,
    bundleable: null,
    versioned: null,
    historical: null,
    reason: null,
    beanORMTextLines: null,
    origin: null,
    patternId: null,
    dao: null,
    writesTables: null,
    writesBasis: null,
    ...PENDING_LIVE,
    ...fields,
  };
}

/** The dynamic-family declaration sites present in the scanned tree; `component` and `bom` describe the declaring file. */
function patternEntries(
  tree: SourceTree,
  parsed: ReadonlyMap<string, CfmlComponent>,
  formBuilder: { file: string; lines: number[] } | null,
): EntityEntry[] {
  const out: EntityEntry[] = [];
  if (formBuilder !== null) {
    out.push(
      entry({
        id: FORM_BUILDER_PATTERN.id,
        class: 'dynamic',
        source: { path: formBuilder.file, lines: [Math.min(...formBuilder.lines), Math.max(...formBuilder.lines)] },
        component: dottedName(formBuilder.file),
        bom: hasBom(tree, formBuilder.file),
        pattern: true,
        table: 'fb_*',
        origin: FORM_BUILDER_PATTERN.origin,
        reason: FORM_BUILDER_PATTERN.reason,
      }),
    );
  }
  for (const p of FUNCTION_PATTERNS) {
    const fn = parsed.get(p.component)?.functions.find((f) => f.name.toLowerCase() === p.method.toLowerCase());
    if (fn === undefined) continue;
    out.push(
      entry({
        id: p.id,
        class: 'dynamic',
        source: { path: p.component, lines: [fn.startLine, fn.endLine] },
        component: dottedName(p.component),
        bom: hasBom(tree, p.component),
        pattern: true,
        origin: p.origin,
        reason: p.reason,
      }),
    );
  }
  return out;
}

/**
 * Static scan of every `core/mura/**.cfc`, classified by its parsed `extends` chain: ORM bases and concrete entities,
 * components holding ORM source as text, `*Bean.cfc` domain beans, and the dynamic-family declaration sites.
 * Live fields stay pending until {@link mergeLive}; domain-bean writes stay null until {@link attachDaoWrites}.
 */
export function extractEntities(tree: SourceTree): EntityExtraction {
  const files = tree.list(ENTITY_SCAN_ROOT, { ext: ['cfc'], recursive: true });
  const parsed = new Map<string, CfmlComponent>();
  for (const file of files) {
    const comp = parseCfmlComponent(file, tree.readText(file));
    if (comp !== null) parsed.set(file, comp);
  }
  const isOrm = ormTest(parsed, extendsResolver(tree, files));

  const found: Array<{ file: string; draft: EntityEntry }> = [];
  let formBuilder: { file: string; lines: number[] } | null = null;
  for (const [file, comp] of parsed) {
    if (file === ORM_ROOT_PATH) continue;
    const attrs = comp.declaration.attrs;
    const ext = attrOrNull(attrs, 'extends');
    const table = attrOrNull(attrs, 'table')?.toLowerCase() ?? null;
    let cls: EntityClass;
    let textLines: number[] | null = null;
    if (ext !== null && isOrm(ext, file)) {
      cls = table === null ? 'orm-base' : 'orm-concrete';
    } else {
      const generated = generatedOrmDeclarations(comp, isOrm);
      if (generated.length > 0) {
        cls = 'not-entity';
        textLines = [...new Set(generated.map((g) => g.line))].sort((a, b) => a - b);
        const fbLines = generated.filter((g) => g.table?.toLowerCase().startsWith('fb_') === true).map((g) => g.line);
        if (formBuilder === null && fbLines.length > 0) formBuilder = { file, lines: fbLines };
      } else if (file.endsWith('Bean.cfc')) {
        cls = 'domain-bean';
      } else {
        continue;
      }
    }
    const draft = entry({
      id: '',
      class: cls,
      source: { path: file, lines: [comp.declaration.line, comp.declaration.endLine] },
      component: dottedName(file),
      extends: ext,
      bom: hasBom(tree, file),
      table,
      entityname: attrOrNull(attrs, 'entityname'),
      registeredName: cls === 'not-entity' ? null : registeredNameOf(attrs.entityname, baseName(file)),
      bundleable: attrOrNull(attrs, 'bundleable'),
      versioned: attrOrNull(attrs, 'versioned'),
      historical: attrOrNull(attrs, 'historical'),
      reason: cls === 'not-entity' ? NOT_ENTITY_REASON : null,
      beanORMTextLines: textLines,
      writesTables: cls === 'orm-concrete' && table !== null ? [table] : null,
      writesBasis: cls === 'orm-concrete' ? 'orm-table' : null,
    });
    found.push({ file, draft });
  }

  // Ids use the component's base name, the form the committed traceability tables cite; a base name that two
  // scanned components share falls back to the path under core/mura, so ids stay unique.
  const baseCounts = new Map<string, number>();
  for (const { file } of found) baseCounts.set(baseName(file), (baseCounts.get(baseName(file)) ?? 0) + 1);
  const idOf = (file: string): string =>
    (baseCounts.get(baseName(file)) ?? 0) > 1
      ? `ent:${file.slice(ENTITY_SCAN_ROOT.length + 1, -'.cfc'.length)}`
      : `ent:${baseName(file)}`;

  const entities = [
    ...found.map(({ file, draft }) => ({ ...draft, id: idOf(file) })),
    ...patternEntries(tree, parsed, formBuilder),
  ].sort(byId);
  const ormIndex = ormEntityIndex(entities);
  return {
    entities,
    ormTables: [...new Set(ormIndex.byComponent.values())].sort(compareText),
    ormIndex,
    counts: classCounts(entities),
  };
}

/** Concrete ORM lookups: component path → table, and lower-cased registered name → component path (first id wins). */
export function ormEntityIndex(entities: readonly EntityEntry[]): OrmEntityIndex {
  const byComponent = new Map<string, string>();
  const byEntityName = new Map<string, string>();
  for (const e of [...entities].sort(byId)) {
    if (e.class !== 'orm-concrete' || e.table === null) continue;
    byComponent.set(e.source.path, e.table);
    const name = e.registeredName?.toLowerCase();
    if (name !== undefined && !byEntityName.has(name)) byEntityName.set(name, e.source.path);
  }
  return { byComponent, byEntityName };
}

/** Entry count per class; dynamic instances are counted only once live data has been merged. */
export function classCounts(entities: readonly EntityEntry[]): EntityClassCounts {
  const count = (test: (e: EntityEntry) => boolean): number => entities.filter(test).length;
  return {
    ormBase: count((e) => e.class === 'orm-base'),
    ormConcrete: count((e) => e.class === 'orm-concrete'),
    notEntity: count((e) => e.class === 'not-entity'),
    domainBean: count((e) => e.class === 'domain-bean'),
    dynamic: entities.some((e) => e.liveStatus === 'live') ? count((e) => e.class === 'dynamic' && !e.pattern) : null,
    dynamicPatterns: count((e) => e.pattern),
  };
}

/** GETs and validates `run.cfm?info=entities` from the legacy origin; throws on a non-200 answer or an invalid payload. */
export async function fetchLiveEntities(origin: string, deps: FetchLiveEntitiesDeps = {}): Promise<LiveEntities> {
  const session = createHttpSession({ baseUrl: origin, fetch: deps.fetch, timeoutMs: deps.timeoutMs });
  const res = await session.get(LIVE_ENTITIES_PATH, { query: { info: 'entities' } });
  if (res.status !== 200) throw new Error(`live entity probe ${res.url} answered HTTP ${res.status}`);
  const parsed = liveEntitiesSchema.safeParse(res.json());
  if (!parsed.success) {
    throw new Error(`live entity probe ${res.url} returned an invalid payload:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** A `dynamic` entry for a registration no static entry declares; `tree` resolves its component's declaration. */
function dynamicInstance(reg: LiveEntity, patternId: string | null, tree: SourceTree | undefined): EntityEntry {
  // The probe's componentPath is a mapping-rooted dotted name, so it resolves from the tree root.
  const file = tree !== undefined && reg.componentPath ? resolveComponentPath(reg.componentPath, 'Application.cfc', tree) : null;
  const comp = tree !== undefined && file !== null ? parseCfmlComponent(file, tree.readText(file)) : null;
  const attrs = comp?.declaration.attrs ?? {};
  const flag = (value: boolean | null): string | null => (value === null ? null : String(value));
  return entry({
    id: `ent:dynamic:${reg.name}`,
    class: 'dynamic',
    source:
      comp === null
        ? { path: LIVE_SOURCE.path, lines: [0, 0] }
        : { path: comp.path, lines: [comp.declaration.line, comp.declaration.endLine] },
    component: reg.componentPath || null,
    extends: attrOrNull(attrs, 'extends'),
    bom: tree !== undefined && comp !== null ? hasBom(tree, comp.path) : null,
    table: reg.table ? reg.table.toLowerCase() : null,
    entityname: attrOrNull(attrs, 'entityname'),
    registeredName: reg.name,
    bundleable: flag(reg.bundleable),
    versioned: flag(reg.versioned),
    historical: flag(reg.historical),
    origin: reg.origin,
    patternId,
    liveRegistered: true,
    liveNames: [reg.name],
    liveInstances: 1,
    liveStatus: 'live',
  });
}

/**
 * Merges live registrations: each is matched to a static entry by component path (by name when it has none) and
 * listed in its `liveNames`; the rest become `dynamic` entries, also counted on their origin's pattern entry.
 * `live === null` resets every entry to pending. `tree` locates the declarations of unmatched registrations.
 */
export function mergeLive(entities: readonly EntityEntry[], live: LiveEntities | null, tree?: SourceTree): EntityEntry[] {
  const statics = entities.filter((e) => e.pattern || e.class !== 'dynamic');
  if (live === null) return statics.map((e) => ({ ...e, ...PENDING_LIVE })).sort(byId);

  const byComponent = new Map<string, EntityEntry>();
  const byName = new Map<string, EntityEntry>();
  for (const e of [...statics].sort(byId)) {
    if (e.pattern || e.component === null) continue;
    if (!byComponent.has(dottedKey(e.component))) byComponent.set(dottedKey(e.component), e);
    const name = e.registeredName?.toLowerCase();
    if (name !== undefined && !byName.has(name)) byName.set(name, e);
  }
  const patternIds = new Map<LiveOrigin, string>();
  for (const e of statics) if (e.pattern && e.origin !== null) patternIds.set(e.origin, e.id);

  const names = new Map<string, string[]>();
  const record = (id: string, name: string): void => {
    names.set(id, [...(names.get(id) ?? []), name]);
  };
  const instances: EntityEntry[] = [];
  for (const reg of live.entities) {
    const target = reg.componentPath
      ? byComponent.get(dottedKey(reg.componentPath))
      : byName.get(reg.name.toLowerCase());
    if (target !== undefined) {
      record(target.id, reg.name);
      continue;
    }
    const instance = dynamicInstance(reg, patternIds.get(reg.origin) ?? null, tree);
    if (instance.patternId !== null) record(instance.patternId, reg.name);
    instances.push(instance);
  }

  const merged = statics.map((e): EntityEntry => {
    const matched = [...(names.get(e.id) ?? [])].sort(compareText);
    return {
      ...e,
      liveRegistered: e.pattern ? null : matched.length > 0,
      liveNames: matched,
      liveInstances: matched.length,
      liveStatus: 'live',
    };
  });
  return [...merged, ...instances].sort(byId);
}

/** `p` and its `extends` ancestors that the index can parse. */
function componentChain(p: string, ctx: ClosureContext): CfmlComponent[] {
  const out: CfmlComponent[] = [];
  const seen = new Set<string>();
  let cur: string | null = p;
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const comp = ctx.index.parsed(cur);
    if (comp === null) break;
    out.push(comp);
    const ext = comp.declaration.attrs.extends;
    cur = ext === undefined || ext === '' ? null : resolveComponentPath(ext, cur, ctx.tree);
  }
  return out;
}

function findMethod(p: string, name: string, ctx: ClosureContext): { unit: CfmlComponent; fn: CfmlFunction } | null {
  for (const unit of componentChain(p, ctx)) {
    const fn = unit.functions.find((f) => f.name.toLowerCase() === name);
    if (fn !== undefined) return { unit, fn };
  }
  return null;
}

/** Component a bean's `save()` hands its data to: the first resolved outside call named `save`, else any write verb. */
function saveTarget(save: { unit: CfmlComponent; fn: CfmlFunction }, bean: string, ctx: ClosureContext): string | null {
  const own = new Set(componentChain(bean, ctx).map((c) => c.path));
  const sites = extractCalls(save.fn, save.unit, { ...ctx, receiver: bean }).filter(
    (s) => s.resolved !== null && !own.has(s.resolved) && WRITE_VERB.test(s.target.method),
  );
  return (sites.find((s) => s.target.method.toLowerCase() === 'save') ?? sites[0])?.resolved ?? null;
}

/** Union of the tables every own method of `component` reaches. */
function methodTables(component: string, ctx: ClosureContext): string[] {
  const tables = new Set<string>();
  for (const fn of ctx.index.parsed(component)?.functions ?? []) {
    if (fn.name === '') continue;
    for (const table of computeClosure({ component, method: fn.name }, ctx).tables) tables.add(table);
  }
  return [...tables].sort(compareText);
}

function daoWrites(e: EntityEntry, ctx: ClosureContext): Pick<EntityEntry, 'dao' | 'writesTables' | 'writesBasis'> {
  const bean = e.source.path;
  const named = ctx.index.resolveBean(`${baseName(bean).replace(/Bean$/, '')}DAO`);
  const save = findMethod(bean, 'save', ctx);
  // No DAO at the pin declares save(), so the closure is rooted at the bean's own save(), which reaches its DAO.
  const saveTables = save === null ? null : computeClosure({ component: bean, method: save.fn.name }, ctx).tables;
  const dao =
    named ??
    (save === null ? null : saveTarget(save, bean, ctx)) ??
    (saveTables !== null && saveTables.length > 0 ? bean : null);
  if (dao === null) return { dao: null, writesTables: null, writesBasis: null };
  if (saveTables !== null) return { dao, writesTables: saveTables, writesBasis: 'bean-save' };
  return { dao, writesTables: methodTables(dao, ctx), writesBasis: 'dao-methods' };
}

/**
 * Fills `dao`, `writesTables` and `writesBasis` of every domain bean, once `ctx.index` exists. The DAO is the bean
 * `<file name less Bean>DAO`, else the component the bean's `save()` delegates to, else the bean itself when its
 * `save()` writes. Tables are the closure of the bean's `save()`, or for a bean without one the union of its DAO's
 * methods; a bean with no DAO keeps null.
 */
export function attachDaoWrites(entities: readonly EntityEntry[], ctx: ClosureContext): EntityEntry[] {
  return entities.map((e) => (e.class === 'domain-bean' ? { ...e, ...daoWrites(e, ctx) } : e));
}
