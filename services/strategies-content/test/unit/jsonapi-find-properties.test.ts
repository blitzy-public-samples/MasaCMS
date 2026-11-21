// findProperties through the JSON API front controller, byte for byte against bodies recorded from the Masa 7.6.1 oracle
// (test/fixtures/legacy-jsonapi-properties.json).
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TENANT_A } from '@opt2/platform/testing';
import { buildTestApp, createRecordingDb, type TestApp } from '../helpers/app.js';
import { seedRecordingDb } from '../helpers/seed.js';
import { contentHeaders, type ContentSubject } from '../helpers/tokens.js';

type Struct = Record<string, unknown>;

interface RequestedCase {
  path: string;
  status: number;
  body?: string;
  method?: string;
  error?: { message: string; code: string };
}

const FX = JSON.parse(readFileSync(new URL('../fixtures/legacy-jsonapi-properties.json', import.meta.url), 'utf8')) as {
  anonymous: Record<string, string>;
  admin: Record<string, string>;
  requested: RequestedCase[];
};

const API = `/_api/json/v1/${TENANT_A.siteId}`;
const ENTITIES = Object.keys(FX.anonymous);

let api: TestApp;

beforeAll(async () => {
  const db = createRecordingDb();
  seedRecordingDb(db);
  api = await buildTestApp({ db, env: { MURA_VARIATIONS: 'true' } });
});

afterAll(async () => {
  await api?.close();
});

/** GET `path` under the site endpoint as `subject`. */
async function get(path: string, subject: ContentSubject) {
  return api.app.inject({ method: 'GET', url: `${API}/${path}`, headers: await contentHeaders(subject) });
}

/** The site endpoint the target reports, which the recorded bodies hold as `<endpoint>`. */
function endpointOf(body: string): string {
  const data = (JSON.parse(body) as { data: Struct }).data;
  return String((data['links'] as Struct)['entities']);
}

/** The path that reaches `entity`'s findProperties; on a site id that is a variable name, `file/properties` is legacy's `file` method. */
function propertiesPath(entity: string): string {
  return entity === 'file' ? '?method=findProperties&entityname=file' : `${entity}/properties`;
}

describe('findProperties bodies', () => {
  it.each(ENTITIES.flatMap((entity): [string, 'anonymous' | 'admin', ContentSubject][] => [
    [entity, 'anonymous', 'anonymous'],
    [entity, 'admin', 's2'],
  ]))('%s answers the %s body legacy answers', async (entity, caller, subject) => {
    const res = await get(propertiesPath(entity), subject);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(FX[caller][entity]?.replaceAll('<endpoint>', endpointOf(res.body)));
  });

  it.each(FX.requested.map((c): [string, RequestedCase] => [c.path, c]))('%s answers as legacy', async (_path, c) => {
    const res = await get(c.path, 'anonymous');
    expect(res.statusCode).toBe(c.status);
    if (c.body === undefined) {
      expect(JSON.parse(res.body)).toEqual({ apiversion: 'v1', method: c.method, error: c.error });
    } else {
      expect(res.body).toBe(c.body.replaceAll('<endpoint>', endpointOf(res.body)));
    }
  });
});
