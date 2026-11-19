import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../../src/lib/paths.js';

const PLAN_MAIN = 'infra/terraform/envs/plan/main.tf';
const PLAN_VARIABLES = 'infra/terraform/envs/plan/variables.tf';
const WEB_ENV = 'web/src/lib/env.ts';
const MURA_NAME = /^MURA_[A-Z0-9_]+$/;

// Build output, generated contract types, tests, tooling scripts and test config are not part of a deployed service.
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'coverage', '.next', 'test', 'scripts']);

const read = (relative: string): string => readFileSync(path.join(REPO_ROOT, relative), 'utf8');
const plan = read(PLAN_MAIN);

/** Repository-relative TypeScript sources under `dir` that a deployed service runs. */
function sources(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(path.join(REPO_ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name) && !child.endsWith('/src/generated')) walk(child);
      } else if (/\.[cm]?tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') && !entry.name.startsWith('vitest.')) {
        out.push(child);
      }
    }
  };
  walk(dir);
  return out.sort();
}

const parse = (file: string): ts.SourceFile =>
  ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, false, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/** `node` and its descendants; comments are trivia and never visited. */
function descendants(node: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node): void => {
    out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/** The variable `node` names as a member, binding, object or type key, or whole string literal, when it is a MURA_<KEY>. */
function settingName(node: ts.Node): string | undefined {
  let name: ts.Node | undefined;
  if (ts.isPropertyAccessExpression(node)) name = node.name;
  else if (ts.isPropertyAssignment(node) || ts.isPropertySignature(node) || ts.isShorthandPropertyAssignment(node)) name = node.name;
  else if (ts.isBindingElement(node)) name = node.propertyName ?? node.name;
  else if (ts.isStringLiteralLike(node)) name = node;
  const text = name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : undefined;
  return text !== undefined && MURA_NAME.test(text) ? text : undefined;
}

interface Scan {
  readonly reads: Set<string>;
  readonly identifiers: Set<string>;
  /** Expressions that build a MURA_ name at run time, as `<file>: <text>`. */
  readonly dynamic: string[];
}

/** Adds the MURA_* reads, identifiers and run-time-built MURA_ names under `root` to `into`. */
function scan(root: ts.Node, sf: ts.SourceFile, into: Scan = { reads: new Set(), identifiers: new Set(), dynamic: [] }): Scan {
  for (const node of descendants(root)) {
    const name = settingName(node);
    if (name !== undefined) into.reads.add(name);
    if (ts.isIdentifier(node)) into.identifiers.add(node.text);
    if ((ts.isTemplateExpression(node) && node.head.text.endsWith('MURA_')) || (ts.isStringLiteralLike(node) && node.text.endsWith('MURA_'))) {
      into.dynamic.push(`${sf.fileName}: ${node.getText(sf)}`);
    }
  }
  return into;
}

const isExported = (statement: ts.Statement): boolean =>
  ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

/** Names a top-level statement declares. */
function declaredNames(statement: ts.Statement): string[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((d) => (ts.isIdentifier(d.name) ? [d.name.text] : []));
  }
  if (
    (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) &&
    statement.name !== undefined
  ) {
    return [statement.name.text];
  }
  return [];
}

const union = <T>(target: Set<T>, items: Iterable<T>): Set<T> => {
  for (const item of items) target.add(item);
  return target;
};

interface PlatformReads {
  /** MURA_<KEY> reads of each exported platform name, through the platform declarations it names. */
  readonly byExport: ReadonlyMap<string, ReadonlySet<string>>;
  /** Reads outside any top-level declaration, which no service could be matched to. */
  readonly unattributed: ReadonlySet<string>;
  readonly dynamic: readonly string[];
}

/** Platform reads by top-level declaration, each also taking the reads of every platform name it mentions or aliases. */
function platformReads(): PlatformReads {
  const reads = new Map<string, Set<string>>();
  const refs = new Map<string, Set<string>>();
  const exported = new Set<string>();
  const unattributed = new Set<string>();
  const dynamic: string[] = [];
  const at = <V>(map: Map<string, Set<V>>, key: string): Set<V> => map.get(key) ?? map.set(key, new Set<V>()).get(key)!;
  for (const file of sources('platform/src')) {
    const sf = parse(file);
    for (const statement of sf.statements) {
      const found = scan(statement, sf);
      dynamic.push(...found.dynamic);
      const names = declaredNames(statement);
      if (names.length === 0) union(unattributed, found.reads);
      for (const name of names) {
        union(at(reads, name), found.reads);
        union(at(refs, name), found.identifiers);
        if (isExported(statement)) exported.add(name);
      }
      const aliases =
        ts.isExportDeclaration(statement) && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)
          ? statement.exportClause.elements
          : ts.isImportDeclaration(statement) && statement.importClause?.namedBindings !== undefined && ts.isNamedImports(statement.importClause.namedBindings)
            ? statement.importClause.namedBindings.elements
            : [];
      for (const element of aliases) {
        if (ts.isExportSpecifier(element)) exported.add(element.name.text);
        if (element.propertyName !== undefined) at(refs, element.name.text).add(element.propertyName.text);
      }
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, mentioned] of refs) {
      const own = at(reads, name);
      const before = own.size;
      for (const other of mentioned) union(own, reads.get(other) ?? []);
      changed ||= own.size !== before;
    }
  }
  const byExport = new Map([...exported].flatMap((name) => ((reads.get(name)?.size ?? 0) > 0 ? [[name, reads.get(name)!] as const] : [])));
  return { byExport, unattributed, dynamic };
}

/** `MURA_<KEY>` of each SETTING_RULES `key`: the variables web's settingVariable builds. */
function webRuleVariables(): Set<string> {
  const declaration = parse(WEB_ENV)
    .statements.flatMap((s) => (ts.isVariableStatement(s) ? [...s.declarationList.declarations] : []))
    .find((d) => ts.isIdentifier(d.name) && d.name.text === 'SETTING_RULES');
  const rules = declaration?.initializer;
  if (rules === undefined || !ts.isObjectLiteralExpression(rules)) throw new Error(`${WEB_ENV} declares no SETTING_RULES object`);
  return new Set(
    rules.properties.map((rule) => {
      const key =
        ts.isPropertyAssignment(rule) && ts.isObjectLiteralExpression(rule.initializer)
          ? rule.initializer.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'key')
              ?.initializer
          : undefined;
      if (key === undefined || !ts.isStringLiteral(key)) throw new Error(`a SETTING_RULES entry of ${WEB_ENV} has no literal key`);
      return `MURA_${key.text.toUpperCase()}`;
    }),
  );
}

interface Derived {
  readonly byService: ReadonlyMap<string, ReadonlySet<string>>;
  readonly platform: PlatformReads;
  readonly dynamic: readonly string[];
}

let derivedCache: Derived | undefined;

/** Each runtime service's MURA_* reads, from its own sources, the platform declarations it names and web's SETTING_RULES. */
function derived(): Derived {
  if (derivedCache !== undefined) return derivedCache;
  const platform = platformReads();
  const dynamic = [...platform.dynamic];
  const byService = new Map<string, Set<string>>();
  for (const service of runtimeServices()) {
    const dir = ['gateway', 'web', 'migration'].includes(service) ? service : `services/${service}`;
    const found: Scan = { reads: new Set(), identifiers: new Set(), dynamic: [] };
    for (const file of sources(dir)) {
      const sf = parse(file);
      scan(sf, sf, found);
    }
    dynamic.push(...found.dynamic);
    const reads = new Set(found.reads);
    // By name, which covers named, aliased, namespace and dynamic platform imports alike.
    for (const name of found.identifiers) union(reads, platform.byExport.get(name) ?? []);
    if (service === 'web') union(reads, webRuleVariables());
    byService.set(service, reads);
  }
  derivedCache = { byService, platform, dynamic };
  return derivedCache;
}

/** Index of the first character at bracket depth 0 from `from` that `stop` accepts, or of the unmatched closing bracket. */
function scanTo(text: string, from: number, stop: (c: string) => boolean): number {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    const c = text.charAt(i);
    if (c === '"') {
      i += 1;
      while (i < text.length && text.charAt(i) !== '"') i += text.charAt(i) === '\\' ? 2 : 1;
    } else if (c === '#') {
      const newline = text.indexOf('\n', i);
      i = (newline === -1 ? text.length : newline) - 1;
    } else if ('{[('.includes(c)) {
      depth += 1;
    } else if ('}])'.includes(c)) {
      depth -= 1;
      if (depth < 0) return i;
    } else if (depth === 0 && stop(c)) {
      return i;
    }
  }
  return text.length;
}

/** The body, without brackets, of the bracketed value that opens at `open`. */
const bracketBody = (text: string, open: number): string => text.slice(open + 1, scanTo(text, open + 1, () => false));

/** The body of the `{…}` or `[…]` value main.tf assigns to `name`. */
function planBlock(name: string): string {
  const start = new RegExp(`^\\s*${name}\\s*=\\s*[{[]`, 'm').exec(plan);
  if (start === null) throw new Error(`${PLAN_MAIN} assigns no ${name}`);
  return bracketBody(plan, start.index + start[0].length - 1);
}

/** The top-level `key = value` entries of an HCL object body. */
function entries(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const key = /(?:\s|#[^\n]*)*(?:"([^"]+)"|([A-Za-z_][\w-]*))\s*=\s*/y;
  let i = 0;
  while (body.slice(i).replace(/#[^\n]*/g, '').trim() !== '') {
    key.lastIndex = i;
    const match = key.exec(body);
    if (match === null) throw new Error(`${PLAN_MAIN}: unparsed entry at "${body.slice(i, i + 60).trim()}"`);
    const start = i + match[0].length;
    i = scanTo(body, start, (c) => c === '\n' || c === ',') + 1;
    out.set(match[1] ?? match[2]!, body.slice(start, i - 1).trim());
  }
  return out;
}

const strings = (text: string): string[] => [...text.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
const runtimeServices = (): string[] => strings(planBlock('runtime_services'));
const muraKeys = (object: string): string[] => [...entries(object.replace(/^\{|\}$/g, '')).keys()].filter((k) => MURA_NAME.test(k));

/** Services whose operator secret env carries a variable, from its `n == "<svc>"` or `contains(local.<list>, n)` condition. */
function operatorSecretReaders(condition: string): string[] {
  const single = /^n == "([a-z-]+)" \?/.exec(condition);
  if (single !== null) return [single[1]!];
  const list = /^contains\(local\.(\w+), n\) \?/.exec(condition);
  if (list !== null) return strings(planBlock(list[1]!));
  throw new Error(`${PLAN_MAIN}: unparsed operator_secret_env condition "${condition}"`);
}

/** The MURA_* variables main.tf gives each service: legacy setting readers, connection env and secret env. */
function planned(): Map<string, Set<string>> {
  const out = new Map(runtimeServices().map((s) => [s, new Set<string>()]));
  const add = (service: string, keys: Iterable<string>): void => {
    const target = out.get(service);
    if (target === undefined) throw new Error(`${PLAN_MAIN} wires MURA_* settings to ${service}, which is not a runtime service`);
    union(target, keys);
  };
  for (const [service, list] of entries(planBlock('legacy_setting_readers'))) add(service, strings(list));
  for (const [service, object] of entries(planBlock('connection_env'))) add(service, muraKeys(object));
  for (const [service, object] of entries(planBlock('secret_env_by_service'))) add(service, muraKeys(object));
  const operator = plan.indexOf('for name, id in {');
  if (operator === -1) throw new Error(`${PLAN_MAIN} has no operator_secret_env name map`);
  const operatorOpen = plan.indexOf('{', operator);
  for (const [name, condition] of entries(bracketBody(plan, operatorOpen))) {
    if (MURA_NAME.test(name)) for (const service of operatorSecretReaders(condition)) add(service, [name]);
  }
  return out;
}

const sorted = (items: Iterable<string>): string[] => [...items].sort();

describe('Cloud Run legacy settings', () => {
  it('reach each service env from its reader list, connection and secret env, and bound the legacy_settings allowlist', () => {
    expect(plan).toContain('{ for k in try(local.legacy_setting_readers[n], []) : k => var.legacy_settings[k] if contains(keys(var.legacy_settings), k) }');
    for (const part of ['try(local.connection_env[n], {}),', 'try(local.secret_env_by_service[n], {}),', 'local.operator_secret_env[n],']) {
      expect(plan).toContain(part);
    }
    expect(plan).toMatch(/legacy_setting_keys\s+= sort\(distinct\(flatten\(values\(local\.legacy_setting_readers\)\)\)\)/);
    expect(plan).toMatch(/MURA_APPRELOADKEY\s+= contains\(local\.legacy_reload_key_readers, n\) \?/);
    expect(read(PLAN_VARIABLES)).toContain('contains(local.legacy_setting_keys, k)');
  });

  it.each(runtimeServices())('give %s exactly the MURA_* variables its source reads', (service) => {
    const message = `${PLAN_MAIN} MURA_* env of ${service} against the variables its source reads`;
    expect(sorted(planned().get(service) ?? []), message).toEqual(sorted(derived().byService.get(service) ?? []));
  });

  it('validate as CFML booleans only settings some service reads', () => {
    const readers = new Set(strings(planBlock('legacy_setting_readers')));
    expect(strings(planBlock('legacy_setting_flags')).filter((flag) => !readers.has(flag))).toEqual([]);
  });

  it('attribute every platform MURA_* read to a declaration a service can name', () => {
    const { platform } = derived();
    expect([...platform.unattributed]).toEqual([]);
    expect(platform.byExport.size).toBeGreaterThan(0);
  });

  it('find every variable name spelled out, except those web builds from SETTING_RULES', () => {
    expect(derived().dynamic).toEqual([`${WEB_ENV}: \`MURA_\${key.toUpperCase()}\``]);
  });
});
