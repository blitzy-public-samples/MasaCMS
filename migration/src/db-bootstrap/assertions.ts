import type { SchemaRoles, SqlClient } from './roles.js';

/** Kinds of role or schema defect the bootstrap's final assertions report. */
export type FindingKind =
  | 'missing-role'
  | 'superuser'
  | 'bypassrls'
  | 'login-attribute'
  | 'privileged-membership'
  | 'cloudsqlsuperuser-membership'
  | 'app-owner-membership'
  | 'app-create-privilege'
  | 'schema-owner'
  | 'schema-public-privilege'
  | 'missing-schema';

/** One defect; `subject` is a role, IAM user or schema name and `detail` one short sentence. */
export interface Finding {
  kind: FindingKind;
  subject: string;
  detail: string;
}

/** The OPT-2 role sets to check, the target they were created for and, in the cloud, the IAM users granted to. */
export interface RoleAssertionInput {
  roles: readonly SchemaRoles[];
  target: 'local' | 'cloud';
  iamUsers?: readonly string[];
}

interface RoleRow {
  rolname: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcanlogin: boolean;
}

interface AncestorRow {
  subject: string;
  via?: string | null;
  ancestor: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
}

interface SchemaRow {
  nspname: string;
  owner: string;
  acl: string[] | null;
}

const CLOUDSQL_SUPERUSER = 'cloudsqlsuperuser';

const ROLE_ATTRIBUTES_SQL =
  'SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = ANY($1::text[])';

// Follows member -> granted role only, so PostgreSQL 16's grant of each new role to its creator is not an ancestor.
const ANCESTORS_SQL = `WITH RECURSIVE up(subject, via, roleid) AS (
  SELECT r.rolname, p.rolname, m.roleid
    FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member JOIN pg_roles p ON p.oid = m.roleid
   WHERE r.rolname = ANY($1::text[])
  UNION
  SELECT u.subject, u.via, m.roleid FROM up u JOIN pg_auth_members m ON m.member = u.roleid)
SELECT u.subject, u.via, a.rolname AS ancestor, a.rolsuper, a.rolbypassrls FROM up u JOIN pg_roles a ON a.oid = u.roleid`;

const SCHEMAS_SQL =
  'SELECT nspname, pg_get_userbyid(nspowner) AS owner, nspacl::text[] AS acl FROM pg_namespace WHERE nspname = ANY($1::text[])';

const APP_CREATE_SQL = "SELECT has_schema_privilege($1::name, $2::text, 'CREATE') AS can_create";

const loginWord = (login: boolean): string => (login ? 'LOGIN' : 'NOLOGIN');

const isDirect = (row: AncestorRow): boolean => !row.via || row.via === row.ancestor;

function membership(row: AncestorRow): string {
  return isDirect(row) ? `member of ${row.ancestor}` : `member of ${row.ancestor} via ${row.via}`;
}

/** Keeps one row per subject and ancestor, preferring a direct grant, then the lowest first hop. */
function ancestorsBySubject(rows: readonly AncestorRow[], subjects: ReadonlySet<string>): Map<string, Map<string, AncestorRow>> {
  const rank = (row: AncestorRow): string => (isDirect(row) ? '' : String(row.via));
  const bySubject = new Map<string, Map<string, AncestorRow>>();
  for (const row of rows) {
    if (!subjects.has(row.subject)) continue;
    let ancestors = bySubject.get(row.subject);
    if (ancestors === undefined) {
      ancestors = new Map();
      bySubject.set(row.subject, ancestors);
    }
    const prior = ancestors.get(row.ancestor);
    if (prior === undefined || rank(row) < rank(prior)) ancestors.set(row.ancestor, row);
  }
  return bySubject;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Reads the role, membership and schema catalogs and returns every defect of the OPT-2 role chain, sorted by
 * subject then kind; an empty array means the chain is sound. Never grants or alters anything.
 */
export async function assertRoles(client: SqlClient, input: RoleAssertionInput): Promise<Finding[]> {
  const cloud = input.target === 'cloud';
  const findings: Finding[] = [];
  const add = (kind: FindingKind, subject: string, detail: string): void => {
    findings.push({ kind, subject, detail });
  };

  // Expected rolcanlogin per role; null leaves an IAM user's login attribute unchecked.
  const expected = new Map<string, boolean | null>();
  for (const roles of input.roles) {
    expected.set(roles.owner, false);
    expected.set(roles.app, !cloud);
    expected.set(roles.migrator, !cloud);
  }
  for (const user of cloud ? (input.iamUsers ?? []) : []) {
    if (!expected.has(user)) expected.set(user, null);
  }
  const names = [...expected.keys()];

  const { rows: roleRows } = await client.query(ROLE_ATTRIBUTES_SQL, [names]);
  const present = new Map((roleRows as RoleRow[]).map((row) => [row.rolname, row]));
  for (const [name, login] of expected) {
    const row = present.get(name);
    if (row === undefined) {
      add('missing-role', name, login === null ? 'IAM database user does not exist' : 'role does not exist');
      continue;
    }
    if (row.rolsuper) add('superuser', name, 'has SUPERUSER');
    if (row.rolbypassrls) add('bypassrls', name, 'has BYPASSRLS');
    if (login !== null && row.rolcanlogin !== login) {
      add('login-attribute', name, `is ${loginWord(row.rolcanlogin)}, expected ${loginWord(login)}`);
    }
  }

  const { rows: ancestorRows } = await client.query(ANCESTORS_SQL, [names]);
  const ancestors = ancestorsBySubject(ancestorRows as AncestorRow[], new Set(names));
  for (const [subject, granted] of ancestors) {
    for (const row of granted.values()) {
      const flags = [row.rolsuper ? 'SUPERUSER' : '', row.rolbypassrls ? 'BYPASSRLS' : ''].filter(Boolean);
      if (flags.length > 0) add('privileged-membership', subject, `${membership(row)}, which has ${flags.join(' and ')}`);
      if (cloud && row.ancestor === CLOUDSQL_SUPERUSER) add('cloudsqlsuperuser-membership', subject, membership(row));
    }
  }
  for (const roles of input.roles) {
    const ownerGrant = ancestors.get(roles.app)?.get(roles.owner);
    if (ownerGrant !== undefined) add('app-owner-membership', roles.app, membership(ownerGrant));
  }

  const { rows: schemaRows } = await client.query(SCHEMAS_SQL, [input.roles.map((roles) => roles.schema)]);
  const schemas = new Map((schemaRows as SchemaRow[]).map((row) => [row.nspname, row]));
  for (const roles of input.roles) {
    const schema = schemas.get(roles.schema);
    if (schema === undefined) {
      add('missing-schema', roles.schema, 'schema does not exist');
      continue;
    }
    if (schema.owner !== roles.owner) {
      add('schema-owner', roles.schema, `owned by ${schema.owner}, expected ${roles.owner}`);
    }
    for (const entry of schema.acl ?? []) {
      if (entry.startsWith('=')) add('schema-public-privilege', roles.schema, `PUBLIC holds ${entry}`);
    }
    if (present.has(roles.app)) {
      const { rows } = await client.query(APP_CREATE_SQL, [roles.app, roles.schema]);
      if ((rows[0] as { can_create?: unknown } | undefined)?.can_create === true) {
        add('app-create-privilege', roles.app, `can CREATE in schema ${roles.schema}`);
      }
    }
  }

  return findings.sort(
    (a, b) => compare(a.subject, b.subject) || compare(a.kind, b.kind) || compare(a.detail, b.detail),
  );
}
