// Key that authorises harness requests to the diagnostic runner `harness/legacy-baseline/cfml/run.cfm`.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { secretsDir, type EnvLike } from './paths.js';

// The `string` annotations keep the secret scan from reading these names as key values.
/** Request header the diagnostic application compares with its own `OPT2_HARNESS_KEY`. */
export const HARNESS_KEY_HEADER: string = 'X-Opt2-Harness-Key';

/** Variable holding the key; `harness/repro/lib/legacy-start.sh` gives ColdFusion the same variable. */
export const HARNESS_KEY_VARIABLE: string = 'OPT2_HARNESS_KEY';

/** File under `${OPT2_STATE_DIR}/secrets/` holding the key. */
export const HARNESS_KEY_FILE = 'harness-diagnostic-key';

/** {@link HARNESS_KEY_VARIABLE}, else the trimmed key file; throws naming both, never a value, when neither holds a key. */
export function harnessKey(env: EnvLike = process.env): string {
  const configured = env[HARNESS_KEY_VARIABLE];
  if (configured !== undefined && configured !== '') return configured;
  const file = path.join(secretsDir(env), HARNESS_KEY_FILE);
  let key = '';
  try {
    key = readFileSync(file, 'utf8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (key === '') {
    throw new Error(
      `no harness diagnostic key: ${HARNESS_KEY_VARIABLE} is unset and ${file} is missing or empty; ` +
        'run `npm run repro:secrets` in harness/',
    );
  }
  return key;
}

/** Request headers carrying {@link harnessKey} for a call to the diagnostic runner. */
export function harnessKeyHeaders(env: EnvLike = process.env): Record<string, string> {
  return { [HARNESS_KEY_HEADER]: harnessKey(env) };
}
