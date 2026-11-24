/** The ACF 2023 probe session as legacy stored it in `toauthtokens.data`: the fixture file's bytes without its one trailing LF. */
import { readFileSync } from 'node:fs';

export const STORED_SESSION_JSON = readFileSync(new URL('../fixtures/legacy/oauth-token-data.json', import.meta.url), 'utf8').replace(/\n$/, '');
