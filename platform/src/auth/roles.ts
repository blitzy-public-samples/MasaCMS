/** Role strings carried in token claims, route `requires` lists and the authorisation matrix. */
export const Roles = Object.freeze({
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
} as const);

/** A role is an opaque string; module and service roles are built at runtime. */
export type Role = string;

/** Roles of the synthetic modules, granted through fixture-seeded Masa groups. */
export const SYNTHETIC_ROLES: readonly string[] = Object.freeze([
  Roles.timesheetsEmployee,
  Roles.timesheetsPrimaryApprover,
  Roles.timesheetsSecondaryApprover,
  Roles.financePreparer,
  Roles.financeApprover,
  Roles.esignatureSigner,
  Roles.esignatureAuditor,
  Roles.reportingExporter,
  Roles.surveysManager,
  Roles.communicationsSender,
]);

/** Role of the managed Pub/Sub push identity. */
export const PUBSUB_INVOKER_ROLE = 'service:pubsub-invoker';

/** Role of the managed Cloud Tasks identity. */
export const TASKS_INVOKER_ROLE = 'service:tasks-invoker';

/** Roles a service identity carries beyond `service:<name>`, keyed by service name. */
export const SERVICE_ROLE_GRANTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  migration: Object.freeze([Roles.platformMigration]),
  operator: Object.freeze([Roles.platformOperator]),
});

const CORE_MODULE_ID = /^0{32}\d{3}$/;
const SERVICE_NAME_FORBIDDEN = /[:\s]/;

/** Whether the id names a core Masa module (32 zeros and three digits) rather than a plugin. */
export function isCoreModuleId(moduleId: string): boolean {
  return CORE_MODULE_ID.test(moduleId);
}

/** Role for a core module grant, e.g. `m:008` for the Users module; throws `TypeError` for plugin ids. */
export function moduleRole(moduleId: string): string {
  if (!isCoreModuleId(moduleId)) {
    throw new TypeError(`Not a core Masa module id: ${moduleId}`);
  }
  return `m:${moduleId.slice(-3)}`;
}

/** Role identifying a calling service workload; throws `TypeError` on an empty name or one with `:` or whitespace. */
export function serviceRole(name: string): string {
  if (name.length === 0 || SERVICE_NAME_FORBIDDEN.test(name)) {
    throw new TypeError(`Invalid service name: ${JSON.stringify(name)}`);
  }
  return `service:${name}`;
}

/** Whether the role belongs to a workload (`service:*` or `platform.*`) rather than a user. */
export function isServiceRole(role: string): boolean {
  return role.startsWith('service:') || role.startsWith('platform.');
}

/** Every role a service identity carries. */
export function rolesForService(name: string): string[] {
  const role = serviceRole(name);
  // Own-property lookup, so names such as `constructor` cannot pick up Object.prototype members.
  const grants = Object.hasOwn(SERVICE_ROLE_GRANTS, name) ? SERVICE_ROLE_GRANTS[name] : undefined;
  return [role, ...(grants ?? [])];
}

/** Whether at least one required role is granted (anyOf, exact match). */
export function hasAnyRole(granted: readonly string[], required: readonly string[]): boolean {
  return required.some((role) => granted.includes(role));
}
