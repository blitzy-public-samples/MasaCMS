import { describe, expect, it } from 'vitest';
import {
  PUBSUB_INVOKER_ROLE,
  Roles,
  SERVICE_ROLE_GRANTS,
  SYNTHETIC_ROLES,
  TASKS_INVOKER_ROLE,
  hasAnyRole,
  isCoreModuleId,
  isServiceRole,
  moduleRole,
  rolesForService,
  serviceRole,
} from '../../src/auth/roles.js';

const ZEROS = '0'.repeat(32);
const USERS_MODULE_ID = `${ZEROS}008`;
const PLUGIN_MODULE_ID = 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';

describe('Roles', () => {
  it('maps each key to its token role string', () => {
    expect(Roles).toEqual({
      s2: 's2',
      siteAdmin: 'site-admin',
      systemUser: 'system-user',
      member: 'member',
      timesheetsEmployee: 'timesheets.employee',
      timesheetsPrimaryApprover: 'timesheets.primary-approver',
      timesheetsSecondaryApprover: 'timesheets.secondary-approver',
      financePreparer: 'finance.preparer',
      financeApprover: 'finance.approver',
      esignatureSigner: 'esignature.signer',
      esignatureAuditor: 'esignature.auditor',
      reportingExporter: 'reporting.exporter',
      surveysManager: 'surveys.manager',
      communicationsSender: 'communications.sender',
      platformMigration: 'platform.migration',
      platformOperator: 'platform.operator',
    });
  });

  it('is frozen and holds distinct values', () => {
    expect(Object.isFrozen(Roles)).toBe(true);
    expect(new Set(Object.values(Roles)).size).toBe(Object.keys(Roles).length);
  });

  it('classifies only the platform roles as service roles', () => {
    expect(Object.values(Roles).filter(isServiceRole)).toEqual(['platform.migration', 'platform.operator']);
  });
});

describe('SYNTHETIC_ROLES', () => {
  it('lists the ten synthetic-module roles in declaration order', () => {
    expect(SYNTHETIC_ROLES).toEqual([
      'timesheets.employee',
      'timesheets.primary-approver',
      'timesheets.secondary-approver',
      'finance.preparer',
      'finance.approver',
      'esignature.signer',
      'esignature.auditor',
      'reporting.exporter',
      'surveys.manager',
      'communications.sender',
    ]);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(SYNTHETIC_ROLES)).toBe(true);
  });
});

describe('invoker roles', () => {
  it('names the managed push and task identities as service roles', () => {
    expect(PUBSUB_INVOKER_ROLE).toBe('service:pubsub-invoker');
    expect(TASKS_INVOKER_ROLE).toBe('service:tasks-invoker');
    expect(serviceRole('pubsub-invoker')).toBe(PUBSUB_INVOKER_ROLE);
    expect(serviceRole('tasks-invoker')).toBe(TASKS_INVOKER_ROLE);
  });
});

describe('SERVICE_ROLE_GRANTS', () => {
  it('grants platform.migration to migration and platform.operator to operator', () => {
    expect(SERVICE_ROLE_GRANTS).toEqual({
      migration: ['platform.migration'],
      operator: ['platform.operator'],
    });
  });

  it('is frozen at both levels', () => {
    expect(Object.isFrozen(SERVICE_ROLE_GRANTS)).toBe(true);
    expect(Object.isFrozen(SERVICE_ROLE_GRANTS.migration)).toBe(true);
    expect(Object.isFrozen(SERVICE_ROLE_GRANTS.operator)).toBe(true);
  });
});

describe('isCoreModuleId', () => {
  it.each([
    ['the site manager module', `${ZEROS}000`],
    ['the users module', USERS_MODULE_ID],
    ['the highest three-digit suffix', `${ZEROS}999`],
  ])('accepts %s', (_label, moduleId) => {
    expect(isCoreModuleId(moduleId)).toBe(true);
  });

  it.each([
    ['an empty string', ''],
    ['a plugin CF uuid', PLUGIN_MODULE_ID],
    ['31 zeros', `${'0'.repeat(31)}008`],
    ['33 zeros', `${'0'.repeat(33)}008`],
    ['a two-digit suffix', `${ZEROS}08`],
    ['a four-digit suffix', `${ZEROS}0008`],
    ['a non-digit suffix', `${ZEROS}00a`],
    ['a non-zero prefix', `1${'0'.repeat(31)}008`],
    ['a trailing newline', `${USERS_MODULE_ID}\n`],
    ['surrounding whitespace', ` ${USERS_MODULE_ID} `],
  ])('rejects %s', (_label, moduleId) => {
    expect(isCoreModuleId(moduleId)).toBe(false);
  });
});

describe('moduleRole', () => {
  it.each([
    [`${ZEROS}000`, 'm:000'],
    [USERS_MODULE_ID, 'm:008'],
    [`${ZEROS}010`, 'm:010'],
  ])('maps %s to %s', (moduleId, expected) => {
    expect(moduleRole(moduleId)).toBe(expected);
  });

  it.each([PLUGIN_MODULE_ID, '', `${ZEROS}08`])('throws TypeError for non-core id %j', (moduleId) => {
    const call = (): string => moduleRole(moduleId);
    expect(call).toThrow(TypeError);
    expect(call).toThrow(`Not a core Masa module id: ${moduleId}`);
  });
});

describe('serviceRole', () => {
  it.each(['people', 'strategies-content', 'e-signature', 'migration', 'stub'])('prefixes %s with service:', (name) => {
    expect(serviceRole(name)).toBe(`service:${name}`);
  });

  it.each([
    ['an empty name', ''],
    ['a colon', 'people:admin'],
    ['an already-prefixed name', 'service:people'],
    ['a space', 'pub sub'],
    ['a tab', 'people\t'],
    ['a newline', 'people\n'],
    ['a non-breaking space', 'people\u00a0'],
  ])('throws TypeError for %s', (_label, name) => {
    const call = (): string => serviceRole(name);
    expect(call).toThrow(TypeError);
    expect(call).toThrow(`Invalid service name: ${JSON.stringify(name)}`);
  });
});

describe('isServiceRole', () => {
  it.each([
    ['service:people', true],
    [PUBSUB_INVOKER_ROLE, true],
    [TASKS_INVOKER_ROLE, true],
    ['platform.migration', true],
    ['platform.operator', true],
    ['s2', false],
    ['site-admin', false],
    ['system-user', false],
    ['member', false],
    ['m:008', false],
    ['timesheets.employee', false],
    ['Service:people', false],
    ['platform', false],
    ['xservice:people', false],
    ['', false],
  ])('returns %s -> %s', (role, expected) => {
    expect(isServiceRole(role)).toBe(expected);
  });
});

describe('rolesForService', () => {
  it.each([
    ['migration', ['service:migration', 'platform.migration']],
    ['operator', ['service:operator', 'platform.operator']],
    ['people', ['service:people']],
    ['pubsub-invoker', ['service:pubsub-invoker']],
    ['constructor', ['service:constructor']],
    ['__proto__', ['service:__proto__']],
    ['toString', ['service:toString']],
    ['hasOwnProperty', ['service:hasOwnProperty']],
  ])('returns the roles of %s', (name, expected) => {
    expect(rolesForService(name)).toEqual(expected);
  });

  it('returns a fresh array on every call', () => {
    const roles = rolesForService('migration');
    roles.push(Roles.s2);
    expect(rolesForService('migration')).toEqual(['service:migration', 'platform.migration']);
    expect(SERVICE_ROLE_GRANTS.migration).toEqual(['platform.migration']);
  });

  it.each(['', 'service:migration', 'mi gration'])('throws TypeError for invalid name %j', (name) => {
    expect(() => rolesForService(name)).toThrow(TypeError);
  });
});

describe('hasAnyRole', () => {
  it.each([
    { label: 'the single required role', granted: ['member'], required: ['member'], expected: true },
    { label: 'one of several required roles', granted: ['s2', 'member'], required: ['site-admin', 's2'], expected: true },
    { label: 'a module role', granted: ['m:008'], required: ['s2', 'm:008'], expected: true },
    { label: 'none of the required roles', granted: ['system-user'], required: ['site-admin'], expected: false },
    { label: 'no granted roles', granted: [], required: ['member'], expected: false },
    { label: 'an empty required list', granted: ['s2'], required: [], expected: false },
    { label: 'a role differing in case', granted: ['S2'], required: ['s2'], expected: false },
    { label: 'a role prefix', granted: ['m:008'], required: ['m:00'], expected: false },
    { label: 'a granted prefix of the required role', granted: ['service:'], required: ['service:people'], expected: false },
  ])('returns $expected for $label', ({ granted, required, expected }) => {
    expect(hasAnyRole(granted, required)).toBe(expected);
  });
});
