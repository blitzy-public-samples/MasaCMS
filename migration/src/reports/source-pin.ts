// Reads the pinned source SHA that every migration report embeds.
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** The pin record held in `opt2/source-pin.json`. */
export interface SourcePin {
  sha: string;
  subject: string;
  repository: string;
  confirmedAt: string;
  confirmCommand: string;
  sourceSha: string;
}

/** Raised when a pin file cannot be read, parsed or trusted. */
export class SourcePinError extends Error {
  override name = 'SourcePinError';

  constructor(pinPath: string, reason: string, options?: ErrorOptions) {
    super(`Source pin ${pinPath}: ${reason}`, options);
  }
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const pinCache = new Map<string, SourcePin>();

/**
 * Returns the frozen pin record at `sourcePinPath`, memoised by resolved path.
 * @throws SourcePinError on a missing or unreadable file, invalid JSON, a malformed sha, or sha !== sourceSha.
 */
export function readSourcePin(sourcePinPath: string): SourcePin {
  const pinPath = path.resolve(sourcePinPath);
  const cached = pinCache.get(pinPath);
  if (cached !== undefined) return cached;

  let text: string;
  try {
    text = readFileSync(pinPath, 'utf8');
  } catch (error) {
    throw new SourcePinError(pinPath, 'missing or unreadable file', { cause: error });
  }
  let parsed: Partial<SourcePin> | null;
  try {
    parsed = JSON.parse(text) as Partial<SourcePin> | null;
  } catch (error) {
    throw new SourcePinError(pinPath, 'invalid JSON', { cause: error });
  }

  const sha = parsed?.sha;
  if (typeof sha !== 'string' || !SHA_PATTERN.test(sha)) {
    throw new SourcePinError(pinPath, `malformed sha ${JSON.stringify(sha)}, expected 40 lowercase hex digits`);
  }
  if (sha !== parsed?.sourceSha) {
    throw new SourcePinError(pinPath, `sha ${sha} does not match sourceSha ${JSON.stringify(parsed?.sourceSha)}`);
  }

  const pin = Object.freeze(parsed as SourcePin);
  pinCache.set(pinPath, pin);
  return pin;
}

/**
 * Returns the pinned source SHA from the pin file at `sourcePinPath`.
 * @throws SourcePinError as {@link readSourcePin}.
 */
export function readSourceSha(sourcePinPath: string): string {
  return readSourcePin(sourcePinPath).sha;
}

/** Clears the memoised pin records so the next read goes to disk. */
export function resetSourcePinCache(): void {
  pinCache.clear();
}
