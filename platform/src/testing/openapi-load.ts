/** Loads OpenAPI documents whose whole components alias the same-named component of another file. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Json = Record<string, unknown>;
type Parse = (text: string) => unknown;

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

// Calls `visit` with every string `$ref` under `node` and the pointer of the object holding it.
function eachRef(node: unknown, pointer: string[], visit: (ref: string, pointer: readonly string[]) => void): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => eachRef(item, [...pointer, String(index)], visit));
  } else if (isRecord(node)) {
    if (typeof node.$ref === 'string') {
      visit(node.$ref, pointer);
    }
    for (const [key, value] of Object.entries(node)) {
      eachRef(value, [...pointer, key], visit);
    }
  }
}

function isAlias(node: unknown): node is Json & { $ref: string } {
  return isRecord(node) && typeof node.$ref === 'string' && !isLocal(node.$ref);
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

// The component `alias` (at components.<kind>.<name> of `file`) names; `chain` holds the aliases already followed.
function aliasTarget(parse: Parse, file: string, kind: string, name: string, alias: Json, chain: readonly string[]): unknown {
  const pointer = ['components', kind, name];
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
  if (segments?.length !== 3 || segments.some((segment, index) => segment !== pointer[index])) {
    throw fail(`must point to ${pointerText(pointer)}`);
  }
  const target = fileURLToPath(url);
  const followed = [...chain, `${file}${pointerText(pointer)}`];
  const key = `${target}${pointerText(pointer)}`;
  if (followed.includes(key)) {
    throw fail(`forms an alias cycle: ${[...followed, key].join(' -> ')}`);
  }
  const node = at(parsedFile(parse, target, fail), pointer);
  if (node === undefined) {
    throw fail(`does not resolve: ${target} has no ${pointerText(pointer)}`);
  }
  if (isAlias(node)) {
    return aliasTarget(parse, target, kind, name, node, followed);
  }
  eachRef(node, pointer, (nested, where) => {
    if (!isLocal(nested)) {
      throw outsideComponent(target, where, nested);
    }
  });
  return node;
}

/**
 * Reads and parses an OpenAPI document. Each `components.<kind>.<name>` that is exactly `{$ref}` to another file's
 * `#/components/<kind>/<name>` becomes a deep copy of that component, resolved relative to the referencing file.
 * Throws TypeError on an unreadable or missing target, a mismatched pointer, sibling keys, an alias cycle, any other
 * non-local `$ref`, or a local `$ref` the result does not resolve.
 */
export function loadOpenApiDocument(file: string | URL, parse: (text: string) => unknown): Record<string, unknown> {
  const path = resolve(typeof file === 'string' ? file : fileURLToPath(file));
  const doc = parse(readFileSync(path, 'utf8'));
  if (!isRecord(doc)) {
    throw new TypeError(`${path}: is not an OpenAPI document object`);
  }
  const components = isRecord(doc.components) ? doc.components : {};
  for (const [kind, entries] of Object.entries(components)) {
    if (!isRecord(entries)) {
      continue;
    }
    for (const [name, entry] of Object.entries(entries)) {
      if (isAlias(entry)) {
        entries[name] = structuredClone(aliasTarget(parse, path, kind, name, entry, []));
      }
    }
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
