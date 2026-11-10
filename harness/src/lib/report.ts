import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from '@opt2/platform/service-kit';
import { REPO_ROOT, repoPath } from './paths.js';
import { readPin, type Pin } from './pin.js';

/** Injectable inputs of the report writers; each defaults to the running script, the system clock and the committed pin. */
export interface ReportOptions {
  /** Recorded as `generatedBy`; defaults to `process.argv[1]` relative to the repository root. */
  generatedBy?: string;
  clock?: () => Date;
  pin?: () => Pin;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Copy of `value` with plain-object keys sorted by code unit, `Date`s as ISO strings and undefined properties
 * dropped; arrays keep their order. Integer-like keys still enumerate first, as JavaScript objects order them.
 */
export function sortKeysDeep(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (!isPlainObject(value)) return value;
  const entries: [string, unknown][] = [];
  for (const key of Object.keys(value).sort(compareCodeUnits)) {
    const child = value[key];
    if (child !== undefined) entries.push([key, sortKeysDeep(child)]);
  }
  // fromEntries defines own properties, so a `__proto__` key stays data instead of replacing the prototype.
  return Object.fromEntries(entries);
}

/** Deterministic JSON text: sorted keys, two-space indent, LF line ends and one trailing newline. */
export function stableStringify(value: unknown): string {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}

function pinnedShaOf(pin: (() => Pin) | undefined): string {
  return pin === undefined ? readPin().sha : pin().sha;
}

function defaultGeneratedBy(): string {
  const script = process.argv[1];
  if (script === undefined || script === '') return 'harness';
  return path.relative(REPO_ROOT, path.resolve(script)).split(path.sep).join('/') || 'harness';
}

async function writeText(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, 'utf8');
}

/**
 * Writes `body` as stable JSON stamped with the pinned `sourceSha`, adding `generatedBy`/`generatedAt` only where
 * absent; a relative `filePath` resolves against the repository root. A conflicting `sourceSha` throws unwritten.
 */
export async function writeJsonReport(
  filePath: string,
  body: Record<string, unknown>,
  opts: ReportOptions = {},
): Promise<{ path: string; body: Record<string, unknown> }> {
  const file = repoPath(filePath);
  const sha = pinnedShaOf(opts.pin);
  if (body.sourceSha !== undefined && body.sourceSha !== sha) {
    throw new Error(`${file}: body.sourceSha ${JSON.stringify(body.sourceSha)} differs from the pinned SHA ${sha}`);
  }
  const stamped: Record<string, unknown> = { ...body, sourceSha: sha };
  if (stamped.generatedBy === undefined) stamped.generatedBy = opts.generatedBy ?? defaultGeneratedBy();
  if (stamped.generatedAt === undefined) stamped.generatedAt = (opts.clock ?? (() => new Date()))().toISOString();
  await writeText(file, stableStringify(stamped));
  return { path: file, body: stamped };
}

/**
 * Writes `# <title>`, a `Source SHA:` line, an empty line and `lines`, ending in exactly one newline; a relative
 * `filePath` resolves against the repository root. Returns the absolute path.
 */
export async function writeMarkdown(
  filePath: string,
  title: string,
  lines: readonly string[],
  opts: Pick<ReportOptions, 'pin'> = {},
): Promise<string> {
  const file = repoPath(filePath);
  const text = [`# ${title}`, `Source SHA: ${pinnedShaOf(opts.pin)}`, '', ...lines].join('\n').replace(/\n+$/, '');
  await writeText(file, `${text}\n`);
  return file;
}

/** Parses the JSON file at `filePath` (relative to the repository root), validated by `schema` when given; errors name the file. */
export async function readJson<T>(filePath: string, schema?: z.ZodType<T>): Promise<T> {
  const file = repoPath(filePath);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    throw new Error(`${file}: cannot be read: ${(err as Error).message}`, { cause: err });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file}: is not valid JSON: ${(err as Error).message}`, { cause: err });
  }
  if (schema === undefined) return json as T;
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${file}: does not match its schema:\n${z.prettifyError(parsed.error)}`, { cause: parsed.error });
  }
  return parsed.data;
}
