// Database settings and tool stubs that keep a harness/repro script a unit test runs off every real database.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SANDBOX_NAME = 'opt2_repro_sandbox';

/** PG_* and MURA_DB* settings naming no real server: loopback port 1 refuses every connection. */
export const SANDBOX_DATABASE_ENV = {
  PG_HOST: '127.0.0.1',
  PG_PORT: '1',
  PG_USER: SANDBOX_NAME,
  PG_PASSWORD: [SANDBOX_NAME, 'pg'].join('-'),
  PG_DATABASE: SANDBOX_NAME,
  MURA_DBHOST: '127.0.0.1',
  MURA_DBPORT: '1',
  MURA_DBUSERNAME: SANDBOX_NAME,
  MURA_DBPASSWORD: [SANDBOX_NAME, 'mssql'].join('-'),
  MURA_DATABASE: SANDBOX_NAME,
} as const;

// `sqlcmd` lists no database; `pg_isready` exits 2, no response.
const STUB_STATUS = { sqlcmd: 0, pg_isready: 2 } as const;

// Appends `[tool, ...argv]` as one JSON line to the log, then exits with the given status.
const STUB = `
const [log, tool, status, ...args] = process.argv.slice(2);
require("fs").appendFileSync(log, JSON.stringify([tool, ...args]) + "\\n");
process.exitCode = Number(status);
`;

/** Writes the stubbed `sqlcmd` and `pg_isready` into `bin`; each call is logged to `log`. */
export function writeDatabaseToolStubs(bin: string, log: string): void {
  const stub = path.join(bin, 'database-tool-stub.cjs');
  writeFileSync(stub, STUB);
  for (const [tool, status] of Object.entries(STUB_STATUS)) {
    writeFileSync(path.join(bin, tool), `#!/usr/bin/env bash\nexec node "${stub}" "${log}" ${tool} ${status} "$@"\n`, {
      mode: 0o755,
    });
  }
}

/** The calls the stubs appended to `log`, in call order. */
export function databaseToolCalls(log: string): string[][] {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as string[]);
}
