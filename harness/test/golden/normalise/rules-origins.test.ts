import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { GoldenConfigError } from '../../../src/golden/errors.js';
import { RULES_PATH, loadRules, normaliseRulesSchema } from '../../../src/golden/normalise/rules.js';
import { originBaseUrl } from '../../../src/golden/session.js';
import type { EnvLike } from '../../../src/lib/paths.js';

const LEGACY_CLONE = 'http://localhost:21680';
const GATEWAY_CLONE = 'http://127.0.0.1:21600';

/** The GoldenConfigError `loadRules` throws for `env`. */
function loadError(env: EnvLike): GoldenConfigError {
  try {
    loadRules(RULES_PATH, env);
  } catch (err) {
    expect(err).toBeInstanceOf(GoldenConfigError);
    return err as GoldenConfigError;
  }
  throw new Error(`loadRules accepted ${JSON.stringify(env)}`);
}

describe('loadRules origins', () => {
  it.each<[string, EnvLike, [string, string]]>([
    ['PORT only', { PORT: '8500' }, ['http://127.0.0.1:8500', 'http://127.0.0.1:8100']],
    ['LEGACY_ORIGIN only, no PORT', { LEGACY_ORIGIN: LEGACY_CLONE }, [LEGACY_CLONE, 'http://127.0.0.1:8100']],
    ['LEGACY_ORIGIN over PORT', { LEGACY_ORIGIN: LEGACY_CLONE, PORT: '8080' }, [LEGACY_CLONE, 'http://127.0.0.1:8100']],
    [
      'OPT2_GATEWAY_URL on a per-clone port',
      { PORT: '21680', OPT2_GATEWAY_URL: GATEWAY_CLONE },
      ['http://127.0.0.1:21680', GATEWAY_CLONE],
    ],
    [
      'trailing slashes on the session origins',
      { LEGACY_ORIGIN: `${LEGACY_CLONE}/`, OPT2_GATEWAY_URL: `${GATEWAY_CLONE}//` },
      [LEGACY_CLONE, GATEWAY_CLONE],
    ],
    [
      'empty CAPTURE_ORIGIN and REPLAY_ORIGIN as unset',
      { CAPTURE_ORIGIN: '', REPLAY_ORIGIN: '', LEGACY_ORIGIN: LEGACY_CLONE, OPT2_GATEWAY_URL: GATEWAY_CLONE },
      [LEGACY_CLONE, GATEWAY_CLONE],
    ],
  ])('defaults to the session origins with %s', (_label, env, expected) => {
    const { values } = loadRules(RULES_PATH, env).origins;
    expect(values).toStrictEqual(expected);
    expect(values).toStrictEqual([originBaseUrl('legacy', env), originBaseUrl('gateway', env)]);
  });

  it.each<[string, EnvLike, [string, string]]>([
    [
      'both session origins',
      {
        CAPTURE_ORIGIN: 'https://capture.example:8443',
        REPLAY_ORIGIN: 'http://127.0.0.1:21699',
        LEGACY_ORIGIN: LEGACY_CLONE,
        OPT2_GATEWAY_URL: GATEWAY_CLONE,
        PORT: '8080',
      },
      ['https://capture.example:8443', 'http://127.0.0.1:21699'],
    ],
    ['an unresolvable legacy origin', { CAPTURE_ORIGIN: `${LEGACY_CLONE}/` }, [LEGACY_CLONE, 'http://127.0.0.1:8100']],
  ])('lets CAPTURE_ORIGIN and REPLAY_ORIGIN override %s', (_label, env, expected) => {
    expect(loadRules(RULES_PATH, env).origins.values).toStrictEqual(expected);
  });

  it.each<[string, EnvLike]>([
    ['nothing set', {}],
    ['only the gateway set', { OPT2_GATEWAY_URL: GATEWAY_CLONE }],
  ])('points at origins.values.0 when neither LEGACY_ORIGIN nor PORT is set (%s)', (_label, env) => {
    const err = loadError(env);
    expect(err.path).toBe(`${RULES_PATH}#/origins/values/0`);
    expect(err.message).toContain('origins.values.0: ${CAPTURE_ORIGIN} is not set and its legacy session origin');
    expect(err.message).toContain('PORT, the legacy ColdFusion port, is not set');
    expect(err.cause).toBeInstanceOf(GoldenConfigError);
  });

  it.each<[string, EnvLike, number, string]>([
    ['LEGACY_ORIGIN with a path', { LEGACY_ORIGIN: `${LEGACY_CLONE}/masa` }, 0, `${LEGACY_CLONE}/masa`],
    ['OPT2_GATEWAY_URL with an ftp scheme', { PORT: '8500', OPT2_GATEWAY_URL: 'ftp://127.0.0.1:21600' }, 1, 'ftp://127.0.0.1:21600'],
    ['CAPTURE_ORIGIN with an ftp scheme', { CAPTURE_ORIGIN: 'ftp://127.0.0.1:21680' }, 0, 'ftp://127.0.0.1:21680'],
    ['REPLAY_ORIGIN with a query', { PORT: '8500', REPLAY_ORIGIN: `${GATEWAY_CLONE}/?x=1` }, 1, `${GATEWAY_CLONE}/?x=1`],
  ])('rejects %s as not an origin', (_label, env, index, value) => {
    const err = loadError(env);
    expect(err.path).toBe(`${RULES_PATH}#/origins/values/${index}`);
    expect(err.message).toContain(`origins.values.${index}: `);
    expect(err.message).toContain(`resolves to ${value}, which is not an http or https origin`);
  });
});

describe('normaliseRulesSchema origins.defaults', () => {
  const doc = parse(readFileSync(RULES_PATH, 'utf8')) as { origins: { defaults: Record<string, string> } };

  it('maps each origin variable to the session origin it defaults to', () => {
    expect(doc.origins.defaults).toStrictEqual({ CAPTURE_ORIGIN: 'legacy', REPLAY_ORIGIN: 'gateway' });
  });

  it.each(['http://127.0.0.1:${PORT}', 'replay', ''])('rejects the default %j', (value) => {
    const changed = { ...doc, origins: { ...doc.origins, defaults: { ...doc.origins.defaults, CAPTURE_ORIGIN: value } } };
    const parsed = normaliseRulesSchema.safeParse(changed);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path)).toContainEqual(['origins', 'defaults', 'CAPTURE_ORIGIN']);
  });
});
