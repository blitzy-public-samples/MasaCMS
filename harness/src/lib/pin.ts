import { readFileSync } from 'node:fs';
import { z } from '@opt2/platform/service-kit';
import { opt2Path } from './paths.js';

/** Absolute path of the source-pin record, `opt2/source-pin.json`. */
export const PIN_PATH: string = opt2Path('source-pin.json');

const hex40 = z.string().regex(/^[0-9a-f]{40}$/, 'must be a 40-character lowercase hex commit id');

/** Shape of the source-pin record; unknown keys are tolerated and `sha` must equal `sourceSha`. */
export const pinSchema = z
  .object({
    sha: hex40,
    subject: z.string().min(1),
    repository: z.string().min(1),
    confirmedAt: z.string().min(1),
    confirmCommand: z.string().min(1),
    sourceSha: hex40,
  })
  .refine((p) => p.sha === p.sourceSha, { message: 'sha and sourceSha differ', path: ['sourceSha'] });

/** A validated source-pin record. */
export type Pin = z.infer<typeof pinSchema>;

/** Raised when the pin file at `path` cannot be read, is not JSON, or fails `pinSchema`. */
export class PinError extends Error {
  override name = 'PinError';
  readonly path: string;

  constructor(path: string, detail: string, options?: ErrorOptions) {
    super(`source pin ${path}: ${detail}`, options);
    this.path = path;
  }
}

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return error.message;
  return issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ${issue.message}` : issue.message;
}

/** Reads and validates the source pin, from `opts.path` or `PIN_PATH`; throws `PinError` on any failure. */
export function readPin(opts: { path?: string } = {}): Pin {
  const file = opts.path ?? PIN_PATH;
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    throw new PinError(file, `cannot be read: ${(err as Error).message}`, { cause: err });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new PinError(file, `is not valid JSON: ${(err as Error).message}`, { cause: err });
  }
  const parsed = pinSchema.safeParse(json);
  if (!parsed.success) {
    throw new PinError(file, describeIssue(parsed.error), { cause: parsed.error });
  }
  return parsed.data;
}

/** The pinned source commit SHA, from `opts.path` or `PIN_PATH`. */
export function pinnedSha(opts: { path?: string } = {}): string {
  return readPin(opts).sha;
}
