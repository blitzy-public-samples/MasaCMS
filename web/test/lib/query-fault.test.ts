// onError's debug page of a failed save, held to the legacy oracle's pages (core/appcfc/onError_include.cfm:177-288).
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEGACY_ERROR_PAGE_HTML, LegacyFaultError, legacyDebugPageHtml, legacyFaultOf } from '@opt2/platform/legacy-compat';
import { resetLegacySettingsForTests } from '@/lib/env';
import { okBody } from '@/lib/gateway-client';
import { encodeHtml } from '@/lib/html';
import { legacyError } from '@/lib/responses';
import { useTestEnv } from '../helpers/env';

interface PageCase {
  name: string;
  /** Each heading's text, as a service's `server_error` stacktrace names it. */
  stacktrace: Record<string, string>;
  /** The headings after `<h1>500 Error</h1>`, as legacy encodes them. */
  headings: string;
}

const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/legacy-query-fault-pages.json', import.meta.url), 'utf8')) as { cases: PageCase[] };

/** A service's 500 `server_error` envelope naming `stacktrace`. */
function serverError(stacktrace: Record<string, unknown>): Record<string, unknown> {
  return { apiversion: 'v1', method: 'invalid', error: { message: 'Unhandled Exception', code: 'server_error', stacktrace } };
}

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

describe('legacy query faults', () => {
  it.each(FIXTURE.cases.map((c) => [c.name, c] as const))('renders the debug page legacy answers %s with', async (_name, { stacktrace, headings }) => {
    vi.stubEnv('MURA_DEBUGGINGENABLED', 'true');
    resetLegacySettingsForTests();
    const fault = legacyFaultOf(serverError(stacktrace));
    expect(fault).toBeInstanceOf(LegacyFaultError);

    const res = legacyError(undefined, fault);

    expect([res.status, res.statusText, res.headers.get('content-type')]).toEqual([500, 'An Error Occurred', 'text/html;charset=UTF-8']);
    const head = legacyDebugPageHtml({ message: '', type: '' }, encodeHtml).slice(0, -'</div>'.length);
    expect(await res.text()).toBe(`${head}${headings}</div>`);
  });

  it('answers error.html for a query fault with debugging off', async () => {
    vi.stubEnv('MURA_DEBUGGINGENABLED', 'false');
    resetLegacySettingsForTests();
    const fields = { dataSource: 'muradb', sql: 'INSERT', errorCode: 'HY000', detail: 'cut' };
    const res = legacyError(undefined, new LegacyFaultError('Error Executing Database Query.', 'Database', fields));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe(LEGACY_ERROR_PAGE_HTML);
  });

  it("raises a service's failed query as the fault a screen's okBody reads", () => {
    const [query] = FIXTURE.cases.filter((c) => c.stacktrace.sql !== undefined);
    const failure = (() => {
      try {
        return okBody({ ok: false, status: 500, body: serverError(query?.stacktrace ?? {}) }, 'people', 'updateUser');
      } catch (err) {
        return err;
      }
    })();
    expect(failure).toBeInstanceOf(LegacyFaultError);
    expect(failure).toMatchObject({ sql: query?.stacktrace.sql, detail: query?.stacktrace.detail });
  });
});
