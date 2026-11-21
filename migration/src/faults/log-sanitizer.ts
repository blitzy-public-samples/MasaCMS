import { realpath } from 'node:fs/promises';
import { Transform, type Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { REDACTED, redactText } from '@opt2/platform/logging';

/** Variable through which the sanitizer receives the JSON array of exact secret values it masks. */
export const LOG_SANITIZER_SECRETS_ENV = 'OPT2_LOG_SANITIZER_SECRETS';

/** Longest partial line held back while its newline is awaited, in UTF-16 code units; a longer line is truncated. */
export const MAX_PENDING_LINE = 1024 * 1024;

/** Written after the kept head of a truncated line. */
export const TRUNCATION_MARKER = ' [truncated]';

// Stricter than harness/src/repro/up-state.ts's display pattern, because a log mask changes the text it matches.
/** Name whose last `_`-separated segment ends in a credential word, optionally plural. */
const CREDENTIAL_NAME = /(?:PASSWORD|PASSWD|PWD|SECRET|KEY|TOKEN)S?$/i;

/** Shell variables that hold directories, though their names end in PWD. */
const SHELL_DIRECTORY_NAMES = new Set(['PWD', 'OLDPWD']);

/** JSON literals, which are flags rather than credentials; masking them corrupts JSON log lines. */
const JSON_LITERAL = /^(?:true|false|null)$/i;

/** Secret values shorter than this are masked only as whole tokens, so words that merely contain them stay readable. */
const SHORT_SECRET_LENGTH = 8;

/** Character that continues a token, so a short secret next to it is part of a longer word. */
const TOKEN_CHAR = /[A-Za-z0-9_]/;

/** Where an overlong line is cut, so no token is split. */
const WHITESPACE = /\s/;

/** Path of this module, which runs as the log sanitizer. */
export function logSanitizerPath(): string {
  return fileURLToPath(import.meta.url);
}

/** Distinct values of the credential-named variables in `envs`, less empty values and JSON literals. */
export function secretValues(...envs: (Readonly<Record<string, string | undefined>> | undefined)[]): string[] {
  const values = new Set<string>();
  for (const [name, value] of envs.flatMap((env) => Object.entries(env ?? {}))) {
    if (value === undefined || value.length === 0 || JSON_LITERAL.test(value)) continue;
    if (CREDENTIAL_NAME.test(name) && !SHELL_DIRECTORY_NAMES.has(name)) values.add(value);
  }
  return [...values];
}

/** Removes the secret list from `env` and returns it; empty when none was handed over. */
export function takeSecrets(env: NodeJS.ProcessEnv): string[] {
  const raw = env[LOG_SANITIZER_SECRETS_ENV];
  delete env[LOG_SANITIZER_SECRETS_ENV];
  if (raw === undefined) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((value: unknown): value is string => typeof value === 'string')) {
    throw new Error(`${LOG_SANITIZER_SECRETS_ENV} must be a JSON array of strings`);
  }
  return parsed;
}

/** Distinct non-empty lines of `secrets`, each without a trailing `\r` and also in its JSON-escaped form, longest first. */
function secretLines(secrets: readonly string[]): string[] {
  const lines = new Set<string>();
  for (const line of secrets.flatMap((secret) => secret.split('\n'))) {
    const value = line.endsWith('\r') ? line.slice(0, -1) : line;
    // Pino writes JSON, where a line with quotes, backslashes or control characters appears escaped.
    if (value.length > 0) lines.add(value).add(JSON.stringify(value).slice(1, -1));
  }
  return [...lines].sort((a, b) => b.length - a.length);
}

/** `text` with every occurrence of the single-line `secrets` replaced by REDACTED, overlapping ones as one. */
function maskSecrets(text: string, secrets: readonly string[]): string {
  const spans: [number, number][] = [];
  for (const secret of secrets) {
    const token = secret.length < SHORT_SECRET_LENGTH;
    for (let at = text.indexOf(secret); at !== -1; at = text.indexOf(secret, at + 1)) {
      const end = at + secret.length;
      if (!token || !(TOKEN_CHAR.test(text.charAt(at - 1)) || TOKEN_CHAR.test(text.charAt(end)))) spans.push([at, end]);
    }
  }
  spans.sort(([a], [b]) => a - b);
  let masked = '';
  let copied = 0;
  for (const [start, end] of spans) {
    if (start >= copied) masked += `${text.slice(copied, start)}${REDACTED}`;
    copied = Math.max(copied, end);
  }
  return masked + text.slice(copied);
}

/** `line` with each of the single-line `secrets` replaced by REDACTED, then its credential patterns masked. */
export function sanitizeLine(line: string, secrets: readonly string[]): string {
  return redactText(maskSecrets(line, secrets));
}

/** Length of the longest tail of `text` that begins one of `secrets` without completing it. */
function secretPrefixLength(text: string, secrets: readonly string[]): number {
  let held = 0;
  for (const secret of secrets) {
    for (let length = Math.min(secret.length - 1, text.length); length > held; length -= 1) {
      if (text.endsWith(secret.slice(0, length))) {
        held = length;
        break;
      }
    }
  }
  return held;
}

/** Masked head of overlong line `text` up to its last whitespace, less any trailing secret prefix, plus the marker. */
function truncatedLine(text: string, secrets: readonly string[]): string {
  const masked = maskSecrets(text, secrets);
  let cut = masked.length;
  while (cut > 0 && !WHITESPACE.test(masked.charAt(cut - 1))) cut -= 1;
  const head = masked.slice(0, cut);
  return `${redactText(head.slice(0, head.length - secretPrefixLength(head, secrets)).trimEnd())}${TRUNCATION_MARKER}`;
}

/** Incremental line sanitizer over text chunks. */
export interface LineSanitizer {
  /** Masked text of the lines `chunk` completes, plus the truncated head of a line longer than the cap. */
  push(chunk: string): string;
  /** Masked text of the partial line left at the end of the input. */
  end(): string;
}

/** Masks whole lines as they complete, so a secret split across chunks is still masked; see {@link LineSanitizer}. */
export function createLineSanitizer(secrets: readonly string[], maxPending = MAX_PENDING_LINE): LineSanitizer {
  const ordered = secretLines(secrets);
  let pending = '';
  // Set once a line is truncated: the rest of that line, up to its newline, is dropped unread.
  let discarding = false;
  return {
    push(chunk) {
      let rest = chunk;
      let masked = '';
      if (discarding) {
        const newline = rest.indexOf('\n');
        if (newline === -1) return '';
        discarding = false;
        masked = '\n';
        rest = rest.slice(newline + 1);
      }
      const lineEnd = rest.lastIndexOf('\n') + 1;
      if (lineEnd > 0) {
        masked += `${pending}${rest.slice(0, lineEnd)}`
          .split('\n')
          .map((line) => sanitizeLine(line, ordered))
          .join('\n');
        pending = rest.slice(lineEnd);
      } else {
        pending += rest;
      }
      if (pending.length > maxPending) {
        masked += truncatedLine(pending, ordered);
        pending = '';
        discarding = true;
      }
      return masked;
    },
    end() {
      const masked = discarding ? '' : sanitizeLine(pending, ordered);
      pending = '';
      discarding = false;
      return masked;
    },
  };
}

/** Copies `input` to `output` with every line masked by {@link createLineSanitizer}; resolves once `input` ends. */
export async function sanitizeStream(input: Readable, output: Writable, secrets: readonly string[]): Promise<void> {
  const lines = createLineSanitizer(secrets);
  // Decoded statefully, so a multi-byte character split across chunks stays whole.
  const decoder = new StringDecoder('utf8');
  const masking = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      done(null, lines.push(decoder.write(chunk)) || undefined);
    },
    flush(done) {
      done(null, lines.push(decoder.end()) + lines.end() || undefined);
    },
  });
  await pipeline(input, masking, output);
}

const entry = process.argv[1];
// Node puts the main module's real path into import.meta.url, so argv[1] is compared after realpath.
if (entry !== undefined && import.meta.url === pathToFileURL(await realpath(entry).catch(() => entry)).href) {
  await sanitizeStream(process.stdin, process.stdout, takeSecrets(process.env));
}
