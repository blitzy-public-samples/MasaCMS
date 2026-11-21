// Writes the migration package's JSON and Markdown reports atomically, each stamped with the pinned source SHA.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { projectReportValue, redactReportMarkdown } from './redact.js';
import { readSourceSha } from './source-pin.js';

/** Where reports are written and the SHA every report carries. */
export interface ReportTarget {
  reportsDir: string;
  sourceSha: string;
}

/** Source of `generatedAt`; the service-kit `Clock` satisfies it. */
export interface ReportClock {
  now(): Date;
}

/** Overrides for the head fields of a JSON report. */
export interface JsonReportOptions {
  clock?: ReportClock;
  generatedBy?: string;
  status?: string;
}

/** Raised when a report path is absolute or does not name a file inside the reports directory. */
export class ReportPathError extends Error {
  override name = 'ReportPathError';
}

const HEAD_KEYS = new Set(['sourceSha', 'generatedBy', 'generatedAt', 'status']);
const SHA_LINE = /^Source SHA:.*$/m;
const SHA_LINES = /^Source SHA:.*$/gm;
const ATX_HEADING = /^#{1,6}\s/;
const systemClock: ReportClock = { now: () => new Date() };

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

/** Builds the report target from an explicit reports directory and the `opt2/source-pin.json` path. */
export function resolveReportTarget(args: { reportsDir: string; sourceShaFile: string }): ReportTarget {
  return { reportsDir: path.resolve(args.reportsDir), sourceSha: readSourceSha(args.sourceShaFile) };
}

/**
 * Absolute path of `relPath` (for example `reconciliation/after-backfill.json`) under `reportsDir`.
 * @throws ReportPathError when `relPath` is absolute or does not resolve to a path strictly inside `reportsDir`.
 */
export function reportFilePath(reportsDir: string, relPath: string): string {
  if (path.isAbsolute(relPath)) throw new ReportPathError(`Report path must be relative, got "${relPath}"`);
  const root = path.resolve(reportsDir);
  const filePath = path.resolve(root, relPath);
  const fromRoot = path.relative(root, filePath);
  if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    throw new ReportPathError(`Report path "${relPath}" does not name a file inside ${root}`);
  }
  return filePath;
}

/** Writes `text` through a same-directory temp file and a rename, so readers never see a partial file. */
export async function writeFileAtomic(filePath: string, text: string): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, text, { encoding: 'utf8', flag: 'wx' });
    await rename(temp, filePath);
  } catch (error) {
    try {
      await unlink(temp);
    } catch (cleanupError) {
      // The original failure stays first; a temp file that could not be removed is reported, never left silently.
      if (!isNotFound(cleanupError)) {
        throw new AggregateError([error, cleanupError], `Writing ${filePath} failed and ${temp} was not removed`);
      }
    }
    throw error;
  }
}

/**
 * Writes `body` as `relPath` under the reports directory and returns its absolute path and the written object.
 * `generatedBy`, `status` and body values are written as {@link projectReportValue} redacts them; the caller's `body` is not changed.
 * Head keys come first, in order: `sourceSha` (always `target.sourceSha`), `generatedBy` (omitted when unset),
 * `generatedAt`, `status` (default `generated`); the remaining `body` keys follow in their original order.
 * @throws ReportPathError as {@link reportFilePath}; serialisation errors are thrown before any file is touched.
 */
export async function writeJsonReport(
  target: ReportTarget,
  relPath: string,
  body: Record<string, unknown>,
  opts: JsonReportOptions = {},
): Promise<{ path: string; report: Record<string, unknown> }> {
  const filePath = reportFilePath(target.reportsDir, relPath);
  const head: [string, unknown][] = [['sourceSha', target.sourceSha]];
  const generatedBy = projectReportValue(opts.generatedBy ?? body.generatedBy, 'generatedBy');
  if (generatedBy !== undefined) head.push(['generatedBy', generatedBy]);
  head.push(['generatedAt', (opts.clock ?? systemClock).now().toISOString()]);
  head.push(['status', projectReportValue(opts.status ?? body.status ?? 'generated', 'status')]);
  const fields = Object.entries(body)
    .filter(([key]) => !HEAD_KEYS.has(key))
    .map(([key, value]): [string, unknown] => [key, projectReportValue(value, key)])
    .filter(([, value]) => value !== undefined);
  // fromEntries defines own properties, so a `__proto__` data key in `body` stays data.
  const report = Object.fromEntries([...head, ...fields]);
  const text = `${JSON.stringify(report, null, 2)}\n`;
  await writeFileAtomic(filePath, text);
  return { path: filePath, report };
}

/**
 * Reads the JSON report at `relPath` under `reportsDir`, or `undefined` when it does not exist.
 * @throws ReportPathError as {@link reportFilePath}; invalid JSON and other read errors propagate.
 */
export async function readJsonReport<T = Record<string, unknown>>(reportsDir: string, relPath: string): Promise<T | undefined> {
  const filePath = reportFilePath(reportsDir, relPath);
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  return JSON.parse(text) as T;
}

/**
 * Returns `markdown` with LF line endings, every `Source SHA:` line set to `sha` (or one inserted after the first
 * ATX heading, else prepended) and exactly one trailing newline.
 */
export function ensureSourceShaLine(markdown: string, sha: string): string {
  const shaLine = `Source SHA: ${sha}`;
  const text = markdown.replace(/\r\n/g, '\n');
  let result: string;
  if (SHA_LINE.test(text)) {
    result = text.replace(SHA_LINES, () => shaLine);
  } else {
    const lines = text.split('\n');
    const heading = lines.findIndex((line) => ATX_HEADING.test(line));
    if (heading === -1) {
      const start = lines.findIndex((line) => !isBlank(line));
      result = start === -1 ? shaLine : `${shaLine}\n\n${lines.slice(start).join('\n')}`;
    } else {
      const rest = lines.slice(heading + 1);
      const restStart = rest.findIndex((line) => !isBlank(line));
      const tail = restStart === -1 ? [] : ['', ...rest.slice(restStart)];
      result = [...lines.slice(0, heading + 1), '', shaLine, ...tail].join('\n');
    }
  }
  return result.replace(/\n*$/, '\n');
}

/** Writes `markdown`, redacted by {@link redactReportMarkdown}, as `relPath` under the reports directory with its `Source SHA:` line ensured. */
export async function writeMarkdownReport(
  target: ReportTarget,
  relPath: string,
  markdown: string,
): Promise<{ path: string; text: string }> {
  const filePath = reportFilePath(target.reportsDir, relPath);
  const text = ensureSourceShaLine(redactReportMarkdown(markdown), target.sourceSha);
  await writeFileAtomic(filePath, text);
  return { path: filePath, text };
}
