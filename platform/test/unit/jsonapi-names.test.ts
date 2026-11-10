import { describe, expect, it } from 'vitest';
import {
  CFML_SCOPE_NAMES,
  COMPONENT_VARIABLES,
  CONTENTNAV_ENTITY,
  DEFINED_FUNCTIONS,
  ENTITY_PRIMARY_KEYS,
  GENERIC_METHODS,
  INHERITED_FUNCTIONS,
  PROCESS_REQUEST_LOCALS,
  PUBLIC_METHODS,
  REGISTERED_ENTITIES,
  VARIATION_ENTITY,
  canonicalMethodName,
  isDefinedApiName,
  isGenericMethod,
  isPublicMethod,
  isValidVariableName,
  type ApiNameContext,
} from '../../src/legacy-compat/jsonapi-names.js';

const lower = (names: readonly string[]): string[] => names.map((name) => name.toLowerCase());

describe('name lists', () => {
  it('lists the public methods as the legacy publicMethods string', () => {
    expect(PUBLIC_METHODS.join(',')).toBe(
      'undeclareEntity,declareEntity,checkSchema,findOne,findMany,findAll,findPermissions,findProperties,' +
        'findNew,findQuery,save,delete,findCrumbArray,generateCSRFTokens,validateEmail,login,logout,submitForm,' +
        'findCalendarItems,validate,processAsyncObject,findRelatedContent,getURLForImage,findVersionHistory,' +
        'findCurrentUser,swagger',
    );
  });

  it('lists 67 distinct declared functions from init to getOAuthTokenInfo', () => {
    expect(DEFINED_FUNCTIONS).toHaveLength(67);
    expect(new Set(lower(DEFINED_FUNCTIONS)).size).toBe(67);
    expect(DEFINED_FUNCTIONS[0]).toBe('init');
    expect(DEFINED_FUNCTIONS.at(-1)).toBe('getOAuthTokenInfo');
  });

  it('declares every public method except submitForm', () => {
    const declared = new Set(lower(DEFINED_FUNCTIONS));
    expect(PUBLIC_METHODS.filter((name) => !declared.has(name.toLowerCase()))).toEqual(['submitForm']);
  });

  it('lists 38 distinct inherited functions ending with the backport includes', () => {
    expect(INHERITED_FUNCTIONS).toHaveLength(38);
    expect(new Set(lower(INHERITED_FUNCTIONS)).size).toBe(38);
    expect(INHERITED_FUNCTIONS.slice(-3)).toEqual(['logError', 'parseXML', 'esapiEncode']);
  });

  it('shares only init between declared and inherited functions', () => {
    const declared = new Set(lower(DEFINED_FUNCTIONS));
    expect(INHERITED_FUNCTIONS.filter((name) => declared.has(name.toLowerCase()))).toEqual(['init']);
  });

  it.each<[string, unknown, unknown]>([
    [
      'GENERIC_METHODS',
      GENERIC_METHODS,
      ['save', 'delete', 'findOne', 'findMany', 'findAll', 'findNew', 'findQuery', 'findProperties', 'findPermissions', 'validate'],
    ],
    [
      'REGISTERED_ENTITIES',
      REGISTERED_ENTITIES,
      [
        'site',
        'content',
        'comment',
        'user',
        'group',
        'address',
        'changeset',
        'feed',
        'category',
        'contentCategoryAssign',
        'file',
        'fileMetaData',
        'changesetCategoryAssignment',
        'stats',
      ],
    ],
    ['VARIATION_ENTITY', VARIATION_ENTITY, 'variationTargeting'],
    ['CONTENTNAV_ENTITY', CONTENTNAV_ENTITY, 'contentnav'],
    [
      'ENTITY_PRIMARY_KEYS',
      ENTITY_PRIMARY_KEYS,
      {
        content: 'contentid',
        group: 'userid',
        user: 'userid',
        feed: 'feedid',
        stats: 'contentid',
        contentCategoryAssign: 'notvalid',
        entityname: 'notvalid',
      },
    ],
    [
      'COMPONENT_VARIABLES',
      COMPONENT_VARIABLES,
      ['siteid', 'useDataNamespaceForAPI', 'endpoint', 'config', 'userUtility', 'serializer', 'entityChecks', 'backportdir'],
    ],
    [
      'CFML_SCOPE_NAMES',
      CFML_SCOPE_NAMES,
      [
        'application',
        'arguments',
        'cffile',
        'cfthread',
        'cgi',
        'client',
        'cookie',
        'form',
        'local',
        'request',
        'server',
        'session',
        'super',
        'this',
        'url',
        'variables',
      ],
    ],
    [
      'PROCESS_REQUEST_LOCALS',
      PROCESS_REQUEST_LOCALS,
      {
        always: [
          'path',
          'responseObject',
          'params',
          'result',
          'headers',
          'paramsArray',
          'pathInfo',
          'httpRequestData',
          'method',
          'apiEnabled',
          'sessionData',
        ],
        withOrigin: ['origin', 'originDomain', 'domain'],
        restMode: ['isBasicAuth', 'isBasicAuthDirect'],
        restAuthorization: ['tokentype', 'tokenvalue'],
        entityPhase: ['siteManager'],
      },
    ],
  ])('holds the legacy %s', (_label, value, expected) => {
    expect(value).toEqual(expected);
  });

  it('makes every entity-generic method public', () => {
    expect(GENERIC_METHODS.filter((name) => !isPublicMethod(name))).toEqual([]);
  });

  it.each<[string, object]>([
    ['PUBLIC_METHODS', PUBLIC_METHODS],
    ['DEFINED_FUNCTIONS', DEFINED_FUNCTIONS],
    ['INHERITED_FUNCTIONS', INHERITED_FUNCTIONS],
    ['GENERIC_METHODS', GENERIC_METHODS],
    ['REGISTERED_ENTITIES', REGISTERED_ENTITIES],
    ['ENTITY_PRIMARY_KEYS', ENTITY_PRIMARY_KEYS],
    ['PROCESS_REQUEST_LOCALS', PROCESS_REQUEST_LOCALS],
    ['PROCESS_REQUEST_LOCALS.always', PROCESS_REQUEST_LOCALS.always],
    ['PROCESS_REQUEST_LOCALS.withOrigin', PROCESS_REQUEST_LOCALS.withOrigin],
    ['PROCESS_REQUEST_LOCALS.restMode', PROCESS_REQUEST_LOCALS.restMode],
    ['PROCESS_REQUEST_LOCALS.restAuthorization', PROCESS_REQUEST_LOCALS.restAuthorization],
    ['PROCESS_REQUEST_LOCALS.entityPhase', PROCESS_REQUEST_LOCALS.entityPhase],
    ['COMPONENT_VARIABLES', COMPONENT_VARIABLES],
    ['CFML_SCOPE_NAMES', CFML_SCOPE_NAMES],
  ])('freezes %s', (_label, value) => {
    expect(Object.isFrozen(value)).toBe(true);
  });
});

describe('isValidVariableName', () => {
  it.each([
    ['a letter-initial name', 'findOne'],
    ['a leading underscore', '_name'],
    ['a leading currency sign', '$name'],
    ['trailing ASCII digits', 'name2'],
    ['non-ASCII letters', 'café'],
    ['a letter number first', '\u2160x'],
    ['a non-leading non-ASCII digit', 'x\u0663'],
    ['a combining mark', 'e\u0301'],
    ['a connector punctuation', 'a\u203fb'],
    ['a format character', 'a\u00adb'],
    ['ignorable controls at the range bounds', 'a\u0000\u0008\u000e\u001b\u007f\u009f'],
  ])('accepts %s', (_label, value) => {
    expect(isValidVariableName(value)).toBe(true);
  });

  it.each([
    ['an empty string', ''],
    ['a leading ASCII digit', '1name'],
    ['a leading non-ASCII digit', '\u0663x'],
    ['a dotted name', 'content.save'],
    ['a scope-qualified name', 'url.method'],
    ['a hyphen', 'find-one'],
    ['a space', 'find one'],
    ['a tab', 'find\tone'],
    ['a carriage return', 'find\rone'],
    ['a control just above the second ignorable range', 'find\u001cone'],
    ['a no-break space', 'find\u00a0one'],
    ['brackets', 'pathInfo[1]'],
    ['an emoji', 'find\u{1f600}'],
  ])('rejects %s', (_label, value) => {
    expect(isValidVariableName(value)).toBe(false);
  });
});

describe('isDefinedApiName', () => {
  it('resolves every declared, inherited, component, scope and always-declared local name', () => {
    const names = [
      ...DEFINED_FUNCTIONS,
      ...INHERITED_FUNCTIONS,
      ...COMPONENT_VARIABLES,
      ...CFML_SCOPE_NAMES,
      ...PROCESS_REQUEST_LOCALS.always,
    ];
    expect(names.filter((name) => !isDefinedApiName(name))).toEqual([]);
  });

  it.each(['FINDONE', 'getbean', 'Variables', 'PARAMS', 'SiteId'])('resolves %s case-insensitively', (name) => {
    expect(isDefinedApiName(name)).toBe(true);
  });

  it.each([
    ['submitForm', 'a public method that is never declared'],
    ['entityName', 'a request parameter'],
    ['contentid', 'a request parameter'],
    ['muraAction', 'a request parameter'],
    ['csrf_token', 'a form field'],
    ['cfid', 'a cookie'],
    ['jsessionid', 'a cookie'],
    ['remote_addr', 'a CGI variable'],
    ['thread', 'the thread scope outside a thread'],
  ])('does not resolve %s, %s', (name) => {
    expect(isDefinedApiName(name)).toBe(false);
  });

  it.each([
    ['a leading digit', '1findOne'],
    ['a dotted name', 'content.save'],
    ['an empty string', ''],
  ])('does not resolve %s, even when registered', (_label, name) => {
    expect(isDefinedApiName(name, { registeredMethods: [name] })).toBe(false);
  });

  const gated: { name: string; ctx: ApiNameContext | undefined; expected: boolean }[] = [
    ...PROCESS_REQUEST_LOCALS.withOrigin.flatMap((name) => [
      { name, ctx: undefined, expected: false },
      { name, ctx: { hasOrigin: false }, expected: false },
      { name, ctx: { restMode: true, hasAuthorization: true, entityPhase: true }, expected: false },
      { name, ctx: { hasOrigin: true }, expected: true },
    ]),
    ...PROCESS_REQUEST_LOCALS.restMode.flatMap((name) => [
      { name, ctx: undefined, expected: false },
      { name, ctx: { hasAuthorization: true }, expected: false },
      { name, ctx: { restMode: true }, expected: true },
    ]),
    ...PROCESS_REQUEST_LOCALS.restAuthorization.flatMap((name) => [
      { name, ctx: undefined, expected: false },
      { name, ctx: { restMode: true }, expected: false },
      { name, ctx: { hasAuthorization: true }, expected: false },
      { name, ctx: { restMode: true, hasAuthorization: true }, expected: true },
    ]),
    ...PROCESS_REQUEST_LOCALS.entityPhase.flatMap((name) => [
      { name, ctx: undefined, expected: false },
      { name, ctx: { hasOrigin: true, restMode: true, hasAuthorization: true }, expected: false },
      { name, ctx: { entityPhase: true }, expected: true },
    ]),
  ];

  it.each(gated)('resolves $name as $expected with context $ctx', ({ name, ctx, expected }) => {
    expect(isDefinedApiName(name, ctx)).toBe(expected);
  });

  it.each([
    { label: 'an array', registeredMethods: ['myPluginMethod'], expected: true },
    { label: 'a set', registeredMethods: new Set(['MyPluginMethod']), expected: true },
    { label: 'a list without it', registeredMethods: ['otherMethod'], expected: false },
    { label: 'an empty list', registeredMethods: [], expected: false },
  ])('resolves a plugin method registered in $label as $expected', ({ registeredMethods, expected }) => {
    expect(isDefinedApiName('MYPLUGINMETHOD', { registeredMethods })).toBe(expected);
  });
});

describe('isPublicMethod', () => {
  it('accepts every public method in any case', () => {
    const names = PUBLIC_METHODS.flatMap((name) => [name, name.toLowerCase(), name.toUpperCase()]);
    expect(names.filter((name) => !isPublicMethod(name))).toEqual([]);
  });

  it.each(['init', 'processRequest', 'AllowAccess', 'getBean', 'esapiEncode'])('rejects the non-public %s', (name) => {
    expect(isPublicMethod(name)).toBe(false);
  });

  it.each([
    { label: 'registered', registeredMethods: ['mypluginmethod'], expected: true },
    { label: 'not registered', registeredMethods: ['otherMethod'], expected: false },
    { label: 'given no registrations', registeredMethods: undefined, expected: false },
  ])('treats a plugin method $label as public: $expected', ({ registeredMethods, expected }) => {
    expect(isPublicMethod('MyPluginMethod', registeredMethods)).toBe(expected);
  });
});

describe('isGenericMethod', () => {
  it.each([
    ['save', true],
    ['FINDONE', true],
    ['Validate', true],
    ['findPermissions', true],
    ['login', false],
    ['findCrumbArray', false],
    ['findVersionHistory', false],
    ['undefined', false],
  ])('returns %s -> %s', (name, expected) => {
    expect(isGenericMethod(name)).toBe(expected);
  });
});

describe('canonicalMethodName', () => {
  it.each([
    ['findone', 'findOne'],
    ['GETURLFORIMAGE', 'getURLForImage'],
    ['submitform', 'submitForm'],
    ['allowaccess', 'AllowAccess'],
    ['ESAPIENCODE', 'esapiEncode'],
    ['Init', 'init'],
    ['findOne', 'findOne'],
    ['myPluginMethod', 'myPluginMethod'],
  ])('spells %s as %s', (name, expected) => {
    expect(canonicalMethodName(name)).toBe(expected);
  });
});
