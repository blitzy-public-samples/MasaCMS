# identity service

Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

Identity decides who someone is and what they may do. It signs administrators and API clients in and out, keeps their sessions, and protects forms against forged submissions. It manages user groups and who belongs to them, permissions on content and admin modules, and the OAuth web-service clients of the Web Services screen. It also issues the site-scoped tokens that every other OPT-2 service trusts, so no other service checks a password or reads a group membership itself.

Contracts: [`contracts/openapi.yaml`](contracts/openapi.yaml) and [`contracts/events/`](contracts/events/). Behaviour-to-code-to-test rows: [`TRACEABILITY.md`](TRACEABILITY.md).

## What it does

- **Sign-in and sign-out.** Admin login, logout and the login screen's forgot-password mail, with Masa's login strikes, role list and remember-me cookies. A session keeps the roles it had at login until the next login, as Masa's does.
- **Sessions on both sides of the seam.** One browser session serves the moved screens and the screens that stay on legacy. Identity holds the session, its login-time snapshot and its CSRF secret; the gateway maps the cookies and asks identity to adopt, read, hydrate and end sessions (`gateway/src/session/`).
- **Forged-submission protection.** CSRF tokens use Masa's formula, and each token is consumed once across legacy and target together.
- **Groups and memberships.** Create and edit groups, add and remove members, list and download members.
- **Permissions.** Read each group's verdict on a content node; read and replace a module's group grants.
- **OAuth clients and REST authentication.** The Web Services screen's clients, and the `Basic`, `Bearer` and `client_credentials` authentication of the REST API.
- **Tokens for everyone else.** A user token per session and site, carrying roles derived from Masa's groups and permissions, and the key set that verifies it.

## Masa features replaced

| Masa feature | Masa source | Here |
|---|---|---|
| Admin login screen, login, logout | `clogin.main`, `login`, `logout` [admin/core/controllers/clogin.cfc:95-118]; `loginManager.login`, `logout` [core/mura/login/loginManager.cfc:324-398,476-516] | `POST /v1/sessions/login` under CSRF context `login`, `POST /v1/sessions/logout`, `GET /v1/sessions/current` |
| Home redirect and no-access gate | `home.redirect` [admin/core/controllers/home.cfc:86-130]; `cmessage.before` [admin/core/controllers/cmessage.cfc:78-82] | `GET /v1/sessions/current`, `GET /v1/sessions/current/sites`; `web/` applies the gate |
| Login and role building | `lookupByCredentials`, `login`, `loginByUserID`, `loginByQuery` [core/mura/user/userUtility.cfc:108-388] | `src/domain/login.ts`, `src/domain/roles.ts`: the `session.mura` user struct and role list, stored as the session's `login_snapshot` |
| Login strikes | `core/mura/user/userstrikes.cfc` | `identity.user_strike`; `POST /internal/v1/accounts/{userId}/login-block` for the Edit User screen |
| CSRF tokens | `validateCSRFTokens`, `generateCSRFTokens` [core/mura/user/sessionUserFacade.cfc:206-252] | `POST /v1/csrf/tokens`; the shared ledger `identity.csrf_claim` behind `/internal/v1/csrf/*` |
| Group CRUD and membership | `cusers.editGroup` to `update` [admin/core/controllers/cusers.cfc:219-353]; `userManager` group reads and membership writes [core/mura/user/userManager.cfc:746-807] | `/v1/groups/**`, `GET /v1/users/{userId}/memberships` |
| Permissions | `cperm.main`, `module`, `updatemodule` [admin/core/controllers/cperm.cfc:110-160]; group verdicts and module grants [core/mura/permission.cfc:86-157,643-669] | `/v1/permissions/**` |
| OAuth clients | `admin/core/controllers/cwebservice.cfc`; `core/mura/client/api/oauth/oauthClientBean.cfc`, `oauthTokenBean.cfc` | `/v1/oauth-clients/**` |
| REST and JSON API authentication, OAuth token endpoints | [core/mura/client/api/json/v1/jsonApiUtility.cfc:398-835,4998-5024] | `POST /internal/v1/authenticate` (called by the gateway before routing); REST `oauth`, `oauth2` and `tokeninfo` |
| JSON API identity methods and the `group` entity | `validateEmail`, `login`, `logout` [core/mura/client/api/json/v1/jsonApiUtility.cfc:1831-1875]; `findCurrentUser` [:2268]; `generateCSRFTokens` [:4111-4115]; entity `group` [:87-91] | Every `/_api/{json,ajax,rest}/v1` path, also behind `/index.cfm` and in any letter case |
| Forgot-password and send-login mail | `sendLoginByEmail`, `sendLoginByUser`, `sendLogin` [core/mura/user/userUtility.cfc:411-646] | `POST /v1/login-mail`, which writes `identity.login-mail.requested.v1` for communications to send |

## Owned data

Schema `identity`, created by `opt2-db bootstrap` (`migration/src/db-bootstrap/`) with three roles:

| Role | Use |
|---|---|
| `identity_owner` | `NOLOGIN`; owns the schema and every object, and FORCE RLS applies to it |
| `identity_app` | Runtime DML only; the service's `PG_USER` |
| `identity_migrator` | Applies `db/migrations/*.sql` after `SET ROLE identity_owner` |

Legacy tables, as split in [`opt2/table-ownership.json`](../../opt2/table-ownership.json):

| Legacy table | Unit | Rows and columns | Rule step |
|---|---|---|---|
| `tusers` | `identity.group_account` | `Type = 1` group rows, every column, including the person-style columns groups leave null and the live `tablist` | 1 |
| `tusers` | `identity.user_account` | `Type = 2`: `UserID`, `UserName`, `Type`, `Admin`, `S2`, `Perm`, `InActive`, `isPublic`, `SiteID`, `remoteID`, `tablist` | 1 |
| `tusers` | `identity.credential` | `Type = 2`: `Password`, `PasswordCreated` | 1 |
| `tusers` | `identity.login_state` | `Type = 2`: `LastLogin` | 1 |
| `tusersmemb` | `identity.membership` | All | 2 |
| `tpermissions` | `identity.permission` | All | 2 |
| `tuseraddresses`, `tusersinterests`, `tuserstags`, `tusersfavorites`, `tclassextenddatauseractivity` | `identity.user_address`, `identity.user_interest`, `identity.user_tag`, `identity.user_favorite`, `identity.extend_data_user_activity` | Rows of `Type = 1` groups; the rows of `Type = 2` users belong to people | 1 |
| `tuserstrikes`, `tuserremotesessions`, `tuserdevice`, `tredirects`, `toauthclients`, `toauthtokens` | `identity.user_strike`, `identity.remote_session`, `identity.user_device`, `identity.redirect`, `identity.oauth_client`, `identity.oauth_token` | All | 1 |
| `ttrash` | `identity.trash` | Rows whose `objectClass` belongs to identity | 1 |

The person columns of `Type = 2` rows belong to people; the reverse projector reassembles each legacy `tusers` row from both owners.

New tables:

| Table | Holds |
|---|---|
| `identity.session` | Session state: user, site, `login_snapshot`, `epoch`, CSRF secret, session mode |
| `identity.csrf_claim` | The single-use CSRF ledger shared by legacy and target requests |
| `identity.account_operation` | The account part of people's roster write protocol |
| `identity.person_contact` | Projection of `people.person.changed.v1`: names and email for mail, lookup by email and member lists |
| `identity.aggregate_version` | Per-aggregate event sequence of identity's topics |

Also owned: the platform tables `tenant_registry`, `tenant_grant`, `changelog`, `unit_gate`, `open_operation`, `migration_batch`, `migration_watermark`, `outbox`, `inbox`, `consumer_aggregate_version`, `scheduled_task_queue` and `scheduled_task_queue_state`.

- Every tenant-owned table has `tenant_id uuid NOT NULL` and row-level security enabled and forced, with the `tenant_isolation` policy on `app.tenant_id`. `tenant_registry`, `tenant_grant`, `unit_gate`, `open_operation` and `migration_watermark` hold tenant metadata only.
- Users and groups of a shared user pool carry the pool site's (umbrella) tenant. Each site's public and private user pools are resolved from `tenant_registry`, never from a token.
- No table declares a foreign key, as in Masa.

## Routes

Every route declares `config.opt2.requires` or `config.opt2.public`; anything else fails start-up. Token roles: `s2`; `site-admin`, a member of the site's private-pool `Admin` group; `m:<nnn>`, a core module grant such as `m:008` (Users); `system-user`, any authenticated private-pool user; `service:<name>`, `platform.migration` and `platform.operator` for workloads. Public legacy routes apply Masa's own checks inside the handler.

### Legacy routes

Route keys are those of `platform/src/legacy-compat/route-key.ts`; the state is the one in `gateway/cutover/versions/v0001.json` to `v0003.json`.

| Route key | Legacy entry | Served by | Committed state |
|---|---|---|---|
| `admin:clogin.main`, `admin:clogin.login`, `admin:clogin.logout` | Login screen, login, logout | `web/` → `/v1/sessions/**`, `POST /v1/csrf/tokens`, `POST /v1/login-mail` | `legacy` |
| `admin:home.redirect`, `admin:cmessage.noaccess` | Post-login redirect, no-access page | `web/` → `GET /v1/sessions/current`, `GET /v1/sessions/current/sites` | `legacy` |
| `admin:cperm.main`, `admin:cperm.module`, `admin:cperm.updatemodule` | Content-node permissions (read), module permissions | `web/` → `/v1/permissions/**` | `legacy` |
| `admin:cwebservice.list`, `admin:cwebservice.save`, `admin:cwebservice.delete` | Web Services list, save, delete | `web/` → `/v1/oauth-clients/**` | `legacy` |
| `admin:cusers.update{type=1}` | Group create and update without a photo or extended attributes | `web/` → `POST /v1/groups`, `PUT /v1/groups/{groupId}` | `legacy` |
| `admin:cusers.editgroup`, `admin:cusers.editgroupmembers`, `admin:cusers.downloadgroupmembers`, `admin:cusers.addtogroup`, `admin:cusers.removefromgroup` | Edit Group, its members, members CSV, add and remove a member | `web/` → `/v1/groups/{groupId}`, `/v1/groups/{groupId}/members`, `/v1/groups/{groupId}/members.csv`, `/v1/groups/{groupId}/members/{userId}` | `legacy` |
| `admin:cusers.edituser`, `admin:ceditprofile.edit` | Edit User, Edit Profile. Identity owns them because opening them can clear login strikes (`removeBlock`) or log the user in again, which writes `LastLogin` | `web/` → people's `/v1` APIs, which call identity's `/internal/v1/accounts/**` | `legacy` |
| `api:` and `rest:` `group.findone`, `group.findall`, `group.findmany`, `group.findquery`, `group.findnew`, `group.findproperties`, `group.findpermissions`, `group.validate`, `group.save` | JSON API `group` entity | `/_api/{json,ajax,rest}/v1*` | `legacy` |
| `api:` and `rest:` `findcurrentuser`, `generatecsrftokens`, `validateemail`, `logout`; `rest:login` | JSON API identity methods | `/_api/{json,ajax,rest}/v1*` | `legacy` |
| `api:login` | JSON API `login` | `/_api/{json,ajax}/v1*` | `legacy-write` (halted, below) |
| `rest:oauth`, `rest:oauth2`, `rest:tokeninfo` | OAuth token and token-info endpoints | `/_api/rest/v1/{siteid}/oauth*`, `…/tokeninfo` | `legacy` |
| `api:group.save{photo}`, `rest:group.save{photo}` | Group save that sets or removes a photo | Legacy only | `legacy-write`, decision |
| `page:login`, `page:sendlogin`, `page:logout` | Public front-end `doaction=login` and `logout`, and the front-end send-login form | Legacy only; the gateway adopts the legacy session a login creates | `legacy-write` (login, sendlogin), `legacy` (logout); legacy-served |

`cwebservice.edit`, the Web Service form, has no entry of its own: the inventory reads its view only as the include that `cwebservice.save` re-renders. With no matching key, the gateway sends it to legacy.

Why the identity routes stay on legacy in this run:

- **Start-up writers.** Every identity unit has an application-start writer in the inventory that is not on the prevented-writer list (`gateway/src/cutover/prevented-writers.ts`): Masa's start-up bundle deploy (`getToWorkUsers`, `getToWorkTrash`, `getToWorkClassExtensionsUsers` in `core/mura/publisher.cfc`), default-site creation [core/mura/settings/settingsDAO.cfc:853] and trash restore [core/mura/trash/trashManager.cfc:433]. `gateway/src/cutover/build-versions.ts` therefore keeps all six identity groups `legacy`-authoritative, and the read entries follow their units. The largest group, `grp:identity.credential`, also holds people's person, address, interest and tag units, because roster create and edit write both owners.
- **Halted cases** ([`opt2/exceptions-list.md`](../../opt2/exceptions-list.md)). `EX-GROUP-VALIDATE` keeps `group.validate` and `EX-GROUP-FEED` keeps the group feed keys on legacy in every version; `EX-LOGIN-LOCKDOWN` keeps `api:login` a `legacy-write` entry. Identity answers those cases with the legacy-shaped 503 naming the entry. `EX-GROUP-VALIDATE-DATA`, `EX-GROUP-FEED-DATA` and `EX-GROUP-USER-RECORD` are open `preserve` entries on which the target fails closed.

The service implements these routes in full, so a later version can move them once those blockers are settled.

### `/v1` APIs

`web/` calls these through the gateway with the session's user token.

| Method and path | Requires | Does |
|---|---|---|
| `GET /v1/sessions/current` | public | The session's user struct and login-time roles, or the anonymous struct |
| `GET /v1/sessions/current/sites` | `system-user`, `s2` | Sites the session may administer, for the site selector |
| `GET`, `POST /v1/sessions/current/admin-state` | public | Read and store admin session-scope values |
| `POST /v1/sessions/login` | public | `clogin.login` under CSRF context `login`, or an MFA challenge attempt |
| `POST /v1/sessions/logout` | public | Ends the session and its legacy session, then redirects to `home.redirect` |
| `POST /v1/csrf/tokens` | public | One CSRF token per context from the session's secret |
| `POST /v1/login-mail` | public | Forgot-password mail to every account with the address; the answer is the same whether or not one matched |
| `GET`, `POST /v1/groups` | `s2`, `site-admin`, `m:008` | List a site's system or member groups with member counts; create a group (`cusers.update`, `type=1`, `action=Add`) |
| `GET`, `PUT /v1/groups/{groupId}` | `s2`, `site-admin`, `m:008` | Read one group (an unknown id yields the defaulted new group); update it |
| `GET /v1/groups/{groupId}/members`, `GET /v1/groups/{groupId}/members.csv` | `s2`, `site-admin`, `m:008` | Members by last name; the legacy users CSV |
| `POST`, `DELETE /v1/groups/{groupId}/members/{userId}` | `s2`, `site-admin`, `m:008` | Add a member under CSRF context `<userId><groupId>addtogroup`; remove one |
| `GET /v1/users/{userId}/memberships` | `s2`, `site-admin`, `m:008` | The Group Memberships tab of Edit User |
| `GET /v1/permissions/content/{contentId}` | `s2`, `site-admin` | Each group's verdict on a content node |
| `GET`, `PUT /v1/permissions/modules/{moduleId}` | `s2`, `site-admin` | A module's group grants; replace them under the module id as CSRF context |
| `GET /v1/permissions/reverse-lookup` | public | `getReversePermLookUp` of the token's site for the session user |
| `GET /v1/oauth-clients`, `GET`, `PUT`, `DELETE /v1/oauth-clients/{clientId}` | `s2` | List, read (defaulted new client for an unknown id), create or update, delete with its tokens |

A caller holding only `m:008` on the group routes also needs `m:000` on the site, as legacy's `cusers.before` requires, and is otherwise refused with 403.

### Internal and managed routes

| Method and path | Transport | Requires | Does |
|---|---|---|---|
| `POST /internal/v1/tokens` | service | `service:gateway` | Mints the site-scoped user token of a session |
| `POST /internal/v1/authenticate` | service | `service:gateway` | Resolves a session cookie, `Basic` or `Bearer` credentials or OAuth client credentials by legacy rules, or returns legacy's exact answer |
| `GET /.well-known/jwks.json` | service | public | The local signer's public key (`OPT2_JWKS_URL`) |
| `POST /internal/v1/sessions:adopt` | service | `service:gateway` | Creates or updates the identity session of a legacy session from the bridge's `op=describe` |
| `GET /internal/v1/sessions/{sid}/state`, `/admin-site`, `/snapshot` | service | `service:gateway` | Active flag and epoch; the selected admin site; the login snapshot, CSRF secret and used tokens for `op=hydrate` |
| `POST /internal/v1/sessions/{sid}:end` | service | `service:gateway` | Ends a session and bumps its epoch |
| `POST /internal/v1/csrf/consume` | service | `service:` `gateway`, `identity`, `people`, `programs-sites`, `strategies-content`, `communications`, `finance`, `reporting`, `surveys`, `timesheets` | Validates and consumes a token once across legacy and target |
| `POST /internal/v1/csrf/claims`, `POST /internal/v1/csrf/claims:settle` | service | `service:gateway` | Takes a `pending-legacy` claim before a validating legacy request; settles what legacy consumed |
| `GET /internal/v1/accounts/{userId}/operations/{operationId}`; `POST …:prepare`, `…:commit`, `…:abort`, `…:finish`, `…:revert` | service | `service:people` | Account side of the roster write protocol: state, then each step |
| `GET /internal/v1/accounts/{userId}`; `POST /internal/v1/accounts/{userId}/login-block`; `POST /internal/v1/accounts:lookup`, `:lookup-all-sites`, `:count`, `:username-candidates`, `:memberships`; `GET /internal/v1/groups` | service | `service:people` | Account columns, login strikes and group lists for people's user screens |
| `POST /internal/v1/migration/apply`; `GET /internal/v1/migration/export`, `changes`, `position`; `GET`, `POST /internal/v1/migration/watermark`; `POST /internal/v1/migration/gate` | service | `platform.migration` | Backfill and feed batches, canonical export, changelog, write position, watermarks, unit gates |
| `POST /internal/v1/events/identity.programs-sites.site.changed.v1`, `POST /internal/v1/events/identity.people.person.changed.v1` | Pub/Sub push | `service:pubsub-invoker` | Event deliveries ([Events](#events)) |
| `POST /internal/v1/outbox/sweep` | Cloud Tasks | `service:tasks-invoker` | The `identity-outbox-sweep` chain: creates the next task, then publishes unpublished outbox rows |
| `POST /internal/v1/task-queues/{queue}/pause`, `resume`, `ensure` | service | `platform.migration`, `platform.operator` | Queue control for the queues identity creates tasks on |
| `GET /healthz` | service | public | Liveness |

## Not built here

- **Withheld** (decision list, [`opt2/decision-list.md`](../../opt2/decision-list.md); they keep running on legacy, inside write windows once their units move): `admin:cusers.update{type=1,action=delete}` and `api:group.delete` (group delete, which also retires a stored photo); `admin:cusers.update{type=1,extdata}` and `api:group.save{extdata}` (File-type extended attributes); `admin:cusers.update{photo}`, `api:group.save{photo}` and `rest:group.save{photo}`; `admin:cperm.update` (the content-node permission save also writes the node's approval-chain assignment, `tapprovalassignments`); `admin:cusers.update{type=2,action=delete}` and `api:user.delete`, which people would own. The gateway sends these variants to legacy, and identity serves none of them: it has no group-delete or content-node permission-save route, its group save refuses a photo or extended attributes, and its JSON API answers a withheld key as an unknown method.
- **Legacy-served:** the public front-end `doaction=login`, `doaction=logout` and send-login form. The gateway adopts the legacy session a front-end login creates and ends the identity session after a legacy logout.
- **Login mail settings.** The site's mail columns of `tsettings` (`Contact`, `sendLoginScript`, …) are programs-sites data that no programs-sites operation serves to identity, so a login mail that needs them answers the legacy-shaped 503 rather than mail with made-up values.

## Legacy behaviour kept on purpose

Reproduced as Masa shows it (see [`opt2/reports/pre-existing-defects.md`](../../opt2/reports/pre-existing-defects.md)):

- The session id is not rotated at login.
- The new-group form defaults to Member (`isPublic = 1`).
- `removeFromGroup` checks no CSRF token, and a missing or invalid token on a module-permission or Web Service save skips only the save.
- The access gate [admin/Application.cfc:443-452]: a signed-in user with no site to administer goes to `clogin.logout`, or to `cMessage.noaccess` when a private-pool user (`S2IsPrivate`). `web/` applies it from `GET /v1/sessions/current` and `GET /v1/sessions/current/sites`.

## Events

Identity writes each event to `identity.outbox` in the transaction of the change, publishes it after commit, and re-publishes anything left behind through the `identity-outbox-sweep` chain. The ordering key is the aggregate id.

| Topic | Kind | Carries | Consumers |
|---|---|---|---|
| `identity.group.changed.v1` | `state` | Full state of one group account | people, strategies-content (group names) |
| `identity.permission.changed.v1` | `state` | Every permission row of one group in one site | strategies-content (`content.permission_projection`) |
| `identity.membership.changed.v1` | `state` | Every group one user belongs to | strategies-content (`content.membership_projection`) |
| `identity.login-mail.requested.v1` | `process` | One login-information mail, rendered as legacy renders it | communications, which sends it |

Migration applies emit only the `state` topics, never `login-mail.requested`.

Consumed:

| Topic | Subscription | Fills |
|---|---|---|
| `programs-sites.site.changed.v1` | `identity.programs-sites.site.changed.v1` | `identity.tenant_registry`: each site's tenant and pools |
| `people.person.changed.v1` | `identity.people.person.changed.v1` | `identity.person_contact` |

## Configuration and running

- **Role map.** [`config/role-map.json`](config/role-map.json) names the private-pool Masa groups that grant the ten synthetic roles (`timesheets.employee`, `finance.approver`, `esignature.signer`, …). `legacy-fixtures` authorises by the same group names, so permission denials compare one to one.
- **Tokens.** Claims `iss`, `aud`, `sub` (Masa `UserID`), `sid`, `tid`, `site`, `roles`, `s2`, `epoch`, `iat`, `exp`; group memberships are never claims. Locally identity signs RS256 with the key pair `secrets/token-signing-private.pem` and `secrets/token-signing-public.pem` under `OPT2_STATE_DIR` (`iss` `opt2-local-identity`, `aud` `opt2-local`, 5 minutes). In the cloud it mints an Identity Platform ID token through `firebase-admin` in the tenant of the user's pool (one hour), which needs `GOOGLE_CLOUD_PROJECT`. No key or secret is in the repository.
- **Environment.** `baseEnvSchema` of `@opt2/platform/service-kit` ([`platform/README.md`](../../platform/README.md#configuration)): `PORT`, `OPT2_SERVICE_NAME`, `OPT2_ENV`, `PG_HOST`, `PG_PORT`, `PG_DATABASE`, `PG_USER`, `PG_PASSWORD`, `OPT2_DB_AUTH`, `CLOUD_SQL_INSTANCE`, `PUBSUB_EMULATOR_HOST`, `GOOGLE_CLOUD_PROJECT`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OPT2_JWKS_URL`, `OPT2_TOKEN_ISSUER`, `OPT2_TOKEN_AUDIENCE`, `OPT2_GATEWAY_URL`, `OPT2_MIGRATION_URL`, `OPT2_SERVICE_URLS`, `OPT2_STATE_DIR`, `OPT2_TASKS_ADAPTER`, `OPT2_STORAGE_ADAPTER`, `TZ`. Identity also reads Masa's own `MURA_<SETTING>` variables where legacy behaviour depends on them (`MURA_CONTEXT`, `MURA_ADMINDOMAIN`, `MURA_ADMINSSL`, `MURA_PORT`, `MURA_SITEIDINURLS`, `MURA_INDEXFILEINURLS`, `MURA_HASHURLS`, `MURA_STRICTHTML`, `MURA_SESSIONBASEDLOCKDOWN`, `MURA_APPRELOADKEY`). It calls people, strategies-content (group member photo extensions) and the gateway (the legacy CSRF ledger), so those must resolve through `OPT2_SERVICE_URLS`.

```sh
npm ci                  # postinstall builds ../../platform
npm run build           # contract types into src/generated/, then tsc into dist/
npm test                # vitest with coverage, >= 90% statements
npm run test:contract
npm run test:security
PORT=8111 npm start     # normally started by harness/repro/up.sh
```

`test/contract` and `test/security` need nothing external. Suites that build the app over PostgreSQL 16 read `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD` and `PG_DATABASE`, create a throwaway schema and roles through `@opt2/platform/testing`, and skip when the database is unreachable.

- **Local.** `harness/repro/up.sh` starts the service natively with `PORT=8111` and `PG_USER=identity_app`, after `opt2-db bootstrap --target local` has created the schema and roles.
- **Cloud.** Cloud Run with `min_instance_count = 0`, internal-only ingress, Cloud SQL IAM database authentication (`OPT2_DB_AUTH=iam`) as a member of `identity_app`, `roles/firebaseauth.admin` for Identity Platform, and the OpenTelemetry Collector sidecar (`infra/terraform/`, plan only).

