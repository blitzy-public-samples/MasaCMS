/** Loads OpenAPI documents whose whole components alias a same-named component or `x-opt2-variants` variant of another file. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Json = Record<string, unknown>;
type Parse = (text: string) => unknown;

/** A component definition: its file, its pointer there and its parsed node. */
interface Definition {
  readonly file: string;
  readonly pointer: readonly string[];
  readonly node: unknown;
}

const VARIANTS = 'x-opt2-variants';

/** Parsed alias targets per parser, by absolute path; only clones of them leave this module. */
const parsedFiles = new WeakMap<Parse, Map<string, unknown>>();

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLocal(ref: string): boolean {
  return ref.startsWith('#/');
}

// RFC 6901 fragment text of `segments`, as a `$ref` writes it.
function pointerText(segments: readonly string[]): string {
  return segments.length === 0 ? '#' : `#/${segments.map((s) => s.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`;
}

// Segments of a fragment `/a/b`: percent-decoded, then `~1` and `~0` unescaped; undefined when malformed.
function fragmentSegments(fragment: string): string[] | undefined {
  if (!fragment.startsWith('/')) {
    return undefined;
  }
  try {
    return fragment
      .slice(1)
      .split('/')
      .map((segment) => decodeURIComponent(segment).replace(/~1/g, '/').replace(/~0/g, '~'));
  } catch {
    return undefined;
  }
}

function at(root: unknown, pointer: readonly string[]): unknown {
  let node = root;
  for (const segment of pointer) {
    node = isRecord(node) ? node[segment] : Array.isArray(node) ? (node[Number(segment)] as unknown) : undefined;
  }
  return node;
}

// Calls `visit` with every string `$ref` under `node`, the pointer of the object holding it and that object.
function eachRef(node: unknown, pointer: string[], visit: (ref: string, pointer: readonly string[], holder: Json) => void): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => eachRef(item, [...pointer, String(index)], visit));
  } else if (isRecord(node)) {
    if (typeof node.$ref === 'string') {
      visit(node.$ref, pointer, node);
    }
    for (const [key, value] of Object.entries(node)) {
      eachRef(value, [...pointer, key], visit);
    }
  }
}

function isAlias(node: unknown): node is Json & { $ref: string } {
  return isRecord(node) && typeof node.$ref === 'string' && !isLocal(node.$ref);
}

// Whether `segments` point to a whole component: components/<kind>/<name> or x-opt2-variants/<variant>/<kind>/<name>.
function isComponentPointer(segments: readonly string[] | undefined): segments is string[] {
  return (segments?.length === 3 && segments[0] === 'components') || (segments?.length === 4 && segments[0] === VARIANTS);
}

function keyOf(definition: Definition): string {
  return `${definition.file}${pointerText(definition.pointer)}`;
}

function outsideComponent(file: string, pointer: readonly string[], ref: string): TypeError {
  return new TypeError(`${file}${pointerText(pointer)}: $ref ${ref} is not local; only a whole component may alias another file`);
}

/** The error the contract helpers raise on a `$ref` that is not `#/...`. */
export function nonLocalRefError(ref: string, pointer: readonly string[]): TypeError {
  return new TypeError(`$ref ${ref} at ${pointerText(pointer)} is not local; load the document with loadOpenApiDocument`);
}

/** Throws nonLocalRefError for the first `$ref` under `doc` that is not `#/...`. */
export function assertLocalRefs(doc: unknown): void {
  eachRef(doc, [], (ref, pointer) => {
    if (!isLocal(ref)) {
      throw nonLocalRefError(ref, pointer);
    }
  });
}

function parsedFile(parse: Parse, path: string, fail: (reason: string) => TypeError): unknown {
  let files = parsedFiles.get(parse);
  if (files === undefined) {
    files = new Map();
    parsedFiles.set(parse, files);
  }
  if (!files.has(path)) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      throw fail(`cannot be read: ${(error as Error).message}`);
    }
    files.set(path, parse(text));
  }
  return files.get(path);
}

// The definition `alias` (at the whole-component `pointer` of `file`) names; `chain` holds the aliases already followed.
function aliasTarget(parse: Parse, file: string, pointer: readonly string[], alias: Json, chain: readonly string[]): Definition {
  const [kind, name] = pointer.slice(-2) as [string, string];
  const ref = String(alias.$ref);
  const fail = (reason: string): TypeError => new TypeError(`${file}${pointerText(pointer)}: $ref ${ref} ${reason}`);
  const siblings = Object.keys(alias).filter((key) => key !== '$ref');
  if (siblings.length > 0) {
    throw fail(`has sibling keys (${siblings.join(', ')}); a component alias is exactly {$ref}`);
  }
  const hash = ref.indexOf('#');
  const url = new URL(hash < 0 ? ref : ref.slice(0, hash), pathToFileURL(file));
  if (url.protocol !== 'file:') {
    throw fail('is not a file reference');
  }
  const segments = hash < 0 ? undefined : fragmentSegments(ref.slice(hash + 1));
  if (!isComponentPointer(segments) || segments.at(-2) !== kind || segments.at(-1) !== name) {
    throw fail(`must point to ${pointerText(['components', kind, name])} or ${pointerText([VARIANTS, '<variant>', kind, name])}`);
  }
  const target = fileURLToPath(url);
  const followed = [...chain, `${file}${pointerText(pointer)}`];
  const key = `${target}${pointerText(segments)}`;
  if (followed.includes(key)) {
    throw fail(`forms an alias cycle: ${[...followed, key].join(' -> ')}`);
  }
  const node = at(parsedFile(parse, target, fail), segments);
  if (node === undefined) {
    throw fail(`does not resolve: ${target} has no ${pointerText(segments)}`);
  }
  if (isAlias(node)) {
    return aliasTarget(parse, target, segments, node, followed);
  }
  eachRef(node, segments, (nested, where) => {
    if (!isLocal(nested)) {
      throw outsideComponent(target, where, nested);
    }
  });
  return { file: target, pointer: segments, node };
}

// Key of the definition the whole component at `pointer` of `file` resolves to, following its aliases.
function definitionKey(parse: Parse, file: string, pointer: string[], fail: (reason: string) => TypeError): string {
  const node = at(parsedFile(parse, file, fail), pointer);
  if (node === undefined) {
    throw fail(`does not resolve: ${file} has no ${pointerText(pointer)}`);
  }
  return isAlias(node) ? keyOf(aliasTarget(parse, file, pointer, node, [])) : `${file}${pointerText(pointer)}`;
}

/**
 * Reads and parses an OpenAPI document. Each `components.<kind>.<name>` that is exactly `{$ref}` to another file's
 * `#/components/<kind>/<name>` or `#/x-opt2-variants/<variant>/<kind>/<name>` becomes a deep copy of that definition,
 * resolved relative to the referencing file. Each `$ref` in a copy must name a component this document aliases to
 * the same definition; variant refs are rewritten to `#/components/<kind>/<name>`.
 * Throws TypeError on an unreadable or missing target, a mismatched pointer, sibling keys, an alias cycle, any other
 * non-local `$ref`, a copied `$ref` that would bind to another definition, or a local `$ref` the result does not resolve.
 */
export function loadOpenApiDocument(file: string | URL, parse: (text: string) => unknown): Record<string, unknown> {
  const path = resolve(typeof file === 'string' ? file : fileURLToPath(file));
  const doc = parse(readFileSync(path, 'utf8'));
  if (!isRecord(doc)) {
    throw new TypeError(`${path}: is not an OpenAPI document object`);
  }
  const components = isRecord(doc.components) ? doc.components : {};
  const aliases: { entries: Json; name: string; pointer: string[]; definition: Definition }[] = [];
  for (const [kind, entries] of Object.entries(components)) {
    if (!isRecord(entries)) {
      continue;
    }
    for (const [name, entry] of Object.entries(entries)) {
      if (isAlias(entry)) {
        const pointer = ['components', kind, name];
        aliases.push({ entries, name, pointer, definition: aliasTarget(parse, path, pointer, entry, []) });
      }
    }
  }
  const bindings = new Map(aliases.map(({ pointer, definition }) => [pointerText(pointer), keyOf(definition)]));
  for (const { entries, name, pointer, definition } of aliases) {
    const copy = structuredClone(definition.node);
    // Applied after the walk: a parser may share one ref object between places (a YAML alias).
    const rewrites: [Json, string][] = [];
    eachRef(copy, pointer, (ref, where, holder) => {
      const source = `${definition.file}${pointerText([...definition.pointer, ...where.slice(pointer.length)])}`;
      const fail = (reason: string): TypeError => new TypeError(`${source}: $ref ${ref} ${reason}`);
      const segments = fragmentSegments(ref.slice(1));
      if (!isComponentPointer(segments)) {
        throw fail('does not point to a whole component');
      }
      const designated = definitionKey(parse, definition.file, segments, fail);
      const local = ['components', ...segments.slice(-2)];
      const bound = bindings.get(pointerText(local));
      if (bound !== designated && at(doc, local) !== undefined) {
        const rebound = bound ?? `the local definition ${pointerText(local)}`;
        throw new TypeError(`${path}${pointerText(where)}: $ref ${ref} designates ${designated} but would bind to ${rebound}`);
      }
      if (segments[0] === VARIANTS) {
        rewrites.push([holder, `#/components/${ref.slice(2).split('/').slice(2).join('/')}`]);
      }
    });
    for (const [holder, ref] of rewrites) {
      holder.$ref = ref;
    }
    entries[name] = copy;
  }
  eachRef(doc, [], (ref, pointer) => {
    if (!isLocal(ref)) {
      throw outsideComponent(path, pointer, ref);
    }
    const segments = fragmentSegments(ref.slice(1));
    if (segments === undefined || at(doc, segments) === undefined) {
      throw new TypeError(`${path}${pointerText(pointer)}: $ref ${ref} does not resolve in the loaded document`);
    }
  });
  return doc;
}
