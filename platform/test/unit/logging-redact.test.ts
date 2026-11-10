import { describe, expect, it } from 'vitest';
import { REDACTED, redactErrorText, redactText } from '../../src/logging/redact.js';

/** Synthetic credential assembled at run time, so no literal secret appears in source. */
function sentinel(kind: string): string {
  return ['opt2', 'sentinel', kind].join('-');
}

const SECRET = sentinel('secret');
const base64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const JWT = [base64url({ alg: 'HS256', typ: 'JWT' }), base64url({ sub: SECRET }), base64url(SECRET)].join('.');

const SECRET_NAMES = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'api_key',
  'apikey',
  'client_secret',
  'csrf_token',
  'csrf_token_expires',
  'session',
  'sessionid',
  'jsessionid',
  'cfid',
  'cftoken',
  'key',
  'signature',
  'sig',
  'hmac',
  'private_key',
];

const MASKED: [string, string, string][] = [
  ['URL userinfo', `https://bob:${SECRET}@db.example.test:5432/app`, 'https://[REDACTED]@db.example.test:5432/app'],
  ['URL userinfo with an unencoded @', `postgres://u:${SECRET}@x@db.example.test/app`, 'postgres://[REDACTED]@db.example.test/app'],
  [
    'URL query values',
    `GET /login?siteid=default&returnUrl=/a?b=${SECRET} failed`,
    'GET /login?siteid=[REDACTED]&returnUrl=[REDACTED] failed',
  ],
  ['URL fragment values', `/cb#access_token=${SECRET}&state=x`, '/cb#access_token=[REDACTED]&state=[REDACTED]'],
  ['Bearer credentials', `rejected Bearer ${SECRET} at gateway`, 'rejected Bearer [REDACTED] at gateway'],
  ['lowercase bearer credentials', `bearer ${SECRET}`, 'bearer [REDACTED]'],
  ['Basic credentials', `Basic ${SECRET}`, 'Basic [REDACTED]'],
  ['Digest credentials', `Digest ${SECRET}`, 'Digest [REDACTED]'],
  ['Negotiate credentials', `Negotiate ${SECRET}`, 'Negotiate [REDACTED]'],
  ['an Authorization header line', `Authorization: Basic ${SECRET}\nHost: x`, 'Authorization: [REDACTED]\nHost: x'],
  ['a Proxy-Authorization header line', `Proxy-Authorization: Bearer ${SECRET}`, 'Proxy-Authorization: [REDACTED]'],
  ['an X-Serverless-Authorization pair', `x-serverless-authorization=${SECRET}`, 'x-serverless-authorization=[REDACTED]'],
  ['a Cookie header line', `Cookie: CFID=${SECRET}; CFTOKEN=${SECRET}`, 'Cookie: [REDACTED]'],
  ['a Set-Cookie header line', `Set-Cookie: CFID=${SECRET}; Path=/; HttpOnly`, 'Set-Cookie: [REDACTED]'],
  ['a JSON Set-Cookie array', `{"set-cookie":["CFID=${SECRET}"]}`, '{"set-cookie":[REDACTED]}'],
  ['a camelCase secret name', `newPassword=${SECRET} csrfToken: ${SECRET}`, 'newPassword=[REDACTED] csrfToken: [REDACTED]'],
  ['a single-quoted value', `password='${SECRET} x'`, "password='[REDACTED]'"],
  ['a double-quoted value', `token="${SECRET} x"`, 'token="[REDACTED]"'],
  ['escaped JSON', `{\\"password\\":\\"${SECRET}\\"}`, '{\\"password\\":\\"[REDACTED]\\"}'],
  ['cookie pairs', `CFID=${SECRET}; CFTOKEN=${SECRET}; other=1`, 'CFID=[REDACTED]; CFTOKEN=[REDACTED]; other=1'],
  ['a SQL PASSWORD literal', `CREATE ROLE c0_app LOGIN PASSWORD '${SECRET}'`, "CREATE ROLE c0_app LOGIN PASSWORD '[REDACTED]'"],
  [
    'a SQL PASSWORD literal with doubled quotes',
    `ALTER ROLE r PASSWORD 'it''s ${SECRET}' VALID UNTIL 'infinity'`,
    "ALTER ROLE r PASSWORD '[REDACTED]' VALID UNTIL 'infinity'",
  ],
  ['an unterminated SQL PASSWORD literal', `CREATE ROLE r PASSWORD '${SECRET}\nGRANT x`, "CREATE ROLE r PASSWORD '[REDACTED]'"],
  ['a SQL Server PASSWORD assignment', `CREATE LOGIN l WITH PASSWORD = '${SECRET}'`, "CREATE LOGIN l WITH PASSWORD = '[REDACTED]'"],
  ['a JWT', `token ${JWT} expired`, 'token [REDACTED] expired'],
  ['an email address', 'notify bob.smith+ops@example.test now', 'notify [REDACTED] now'],
  ...SECRET_NAMES.flatMap((name): [string, string, string][] => [
    [`${name}=value`, `${name}=${SECRET}&next`, `${name}=[REDACTED]&next`],
    [`${name}: value`, `${name.toUpperCase()}: ${SECRET} end`, `${name.toUpperCase()}: [REDACTED] end`],
    [`JSON "${name}"`, `{"${name}":"${SECRET}","n":1}`, `{"${name}":"[REDACTED]","n":1}`],
  ]),
];

const KEPT: [string, string][] = [
  ['an empty string', ''],
  ['a tenant UUID', 'tenant edec963e-3516-5bb6-845d-d01a710e32a7'],
  ['a CF UUID', 'user A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6'],
  ['trace and span ids', 'trace 0af7651916cd43dd8448eb211c80319c span b7ad6b7169203331'],
  [
    'stack frames',
    [
      'TypeError: boom',
      '    at handler (/repo/platform/src/service-kit/app.ts:12:7)',
      '    at file:///repo/platform/node_modules/@scope/pkg/dist/index.js:10:5',
      '    at Object.<anonymous> (/repo/node_modules/.pnpm/pino@10.4.0/node_modules/pino/lib/proto.js:243:10)',
      '    at async Promise.all (index 0)',
    ].join('\n'),
  ],
  ['a PostgreSQL authentication error', 'password authentication failed for user "opt2_people"'],
  ['a PostgreSQL constraint error', 'duplicate key value violates unique constraint "person_pkey"'],
  ['a connection error', 'connect ECONNREFUSED 127.0.0.1:5432'],
  ['a listen address', 'Server listening at http://127.0.0.1:3000'],
  ['a property access error', "Cannot read properties of undefined (reading 'token')"],
  ['prose naming schemes and secrets', 'basic digest negotiate checks passed; 3 tokens remain'],
];

describe('redactText', () => {
  it('writes the REDACTED placeholder', () => {
    expect(REDACTED).toBe('[REDACTED]');
  });

  it.each(MASKED)('masks %s', (_, input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it.each(KEPT)('keeps %s unchanged', (_, input) => {
    expect(redactText(input)).toBe(input);
  });

  it.each([...MASKED.map(([name, input]) => [name, input]), ...KEPT])('is idempotent on %s', (_, input) => {
    const once = redactText(input);
    expect(redactText(once)).toBe(once);
  });

  it('stays linear on adversarial input', () => {
    const inputs = [
      'a.'.repeat(100_000),
      '?a'.repeat(100_000),
      'x@'.repeat(100_000),
      'a-'.repeat(100_000),
      'token'.padEnd(200_000, ' '),
      'tokentoken'.repeat(20_000),
      '"password":'.repeat(20_000),
      "PASSWORD '".repeat(20_000),
      'https://a'.repeat(20_000),
      'eyJa.'.repeat(40_000),
    ];
    const started = performance.now();
    for (const input of inputs) {
      redactText(input);
    }
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

const ECHO = ['c10', 'sentinel'].join('-');

const ERROR_MASKED: [string, string, string][] = [
  ['a PostgreSQL syntax error echoing a literal', `syntax error at or near "'${ECHO}'"`, 'syntax error at or near "[REDACTED]"'],
  ['a PostgreSQL input syntax error', `invalid input syntax for type uuid: "${ECHO}"`, 'invalid input syntax for type uuid: "[REDACTED]"'],
  ['a JSON.parse error', `Unexpected token 'c', "${ECHO}" is not valid JSON`, `Unexpected token 'c', "[REDACTED]" is not valid JSON`],
  ['escaped quotes inside a fragment', `rejected "say \\"${ECHO}\\" twice" at 3`, 'rejected "[REDACTED]" at 3'],
  [
    'each fragment of a stack',
    `error: near "${ECHO}"\n    at q (/repo/src/db.ts:1:2)\ncaused by "${ECHO}"`,
    'error: near "[REDACTED]"\n    at q (/repo/src/db.ts:1:2)\ncaused by "[REDACTED]"',
  ],
  ['a credential outside the quotes', `password=${SECRET} near "${ECHO}"`, 'password=[REDACTED] near "[REDACTED]"'],
  ['a fragment whose escaping backslash a masked value ends with', `near "/cb?q=${ECHO}\\"`, 'near "[REDACTED]"'],
];

const ERROR_KEPT: [string, string][] = [
  ['an unterminated quote', 'missing closing quote in "abc'],
  ['a quote pair split across lines', 'first "line\n    at f (/repo/src/a.ts:1:2) second" line'],
  ['single-quoted text', "Cannot read properties of undefined (reading 'token')"],
];

describe('redactErrorText', () => {
  it.each(ERROR_MASKED)('masks %s', (_, input, expected) => {
    expect(redactErrorText(input)).toBe(expected);
  });

  it.each(ERROR_KEPT)('keeps %s unchanged', (_, input) => {
    expect(redactErrorText(input)).toBe(input);
  });

  it.each([...ERROR_MASKED.map(([name, input]) => [name, input]), ...ERROR_KEPT, ...MASKED.map(([name, input]) => [name, input]), ...KEPT])(
    'is idempotent on %s',
    (_, input) => {
      const once = redactErrorText(input);
      expect(redactErrorText(once)).toBe(once);
    },
  );

  it.each([
    ['consumer "people.person.archived.v1" ready', 'consumer "[REDACTED]" ready'],
    ['duplicate key value violates unique constraint "person_pkey"', 'duplicate key value violates unique constraint "[REDACTED]"'],
  ])('masks a quoted identifier in %j that redactText keeps', (input, expected) => {
    expect(redactText(input)).toBe(input);
    expect(redactErrorText(input)).toBe(expected);
  });

  it('stays linear on adversarial input', () => {
    const inputs = [
      `"${'\\"'.repeat(200_000)}\\`,
      '\\"a'.repeat(100_000),
      '"'.repeat(200_000),
      '"\n'.repeat(100_000),
      '"\\'.repeat(100_000),
    ];
    const started = performance.now();
    for (const input of inputs) {
      redactErrorText(input);
    }
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
