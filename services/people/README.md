# people service

Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

People keeps the person roster of each site: who the system users and site members are, their contact details, address book, interests, tags, favourites and extended attributes, and when a person was archived. It replaces the user-facing half of Masa's user administration: the user branches of `admin/core/controllers/cusers.cfc`, `ceditprofile.cfc`, and `core/mura/user/{userManager,userDAO,userBean,addressBean,userGateway}.cfc`. Accounts, passwords, logins and group memberships stay with identity; people changes them only through identity's API, under the roster write protocol ([below](#roster-write-protocol)).

Contracts: [`contracts/openapi.yaml`](contracts/openapi.yaml) and [`contracts/events/`](contracts/events/). Behaviour-to-code-to-test rows: [`TRACEABILITY.md`](TRACEABILITY.md).

## Masa features replaced

Route keys are those of `platform/src/legacy-compat/route-key.ts`. Dispositions come from [`opt2/inventory/legacy-inventory.json`](../../opt2/inventory/legacy-inventory.json).

| Feature | Legacy source | Target route key(s) | Disposition |
|---|---|---|---|
| Group and user lists with paging | `cusers.default`, `list`, `listUsers` [admin/core/controllers/cusers.cfc:174-217]; `userManager.getUserGroups`, `getUsers` [core/mura/user/userManager.cfc:119-123,1129-1135]; `userGateway.getUsers` [core/mura/user/userGateway.cfc:679-716] | `admin:cusers.default`, `admin:cusers.list`, `admin:cusers.listusers` | carry |
| Search and advanced search | `cusers.search`, `advancedSearch` [admin/core/controllers/cusers.cfc:402-451]; `userGateway.getSearch`, `getAdvancedSearch` [core/mura/user/userGateway.cfc:124-592] | `admin:cusers.search`, `admin:cusers.advancedsearch` | carry |
| CSV downloads, in Masa's download format (`legacyUsersCsvStream` of `@opt2/platform/legacy-compat`) | `cusers.advancedSearchToCSV`, `download` [admin/core/controllers/cusers.cfc:453-496] | `admin:cusers.advancedsearchtocsv`, `admin:cusers.download` | carry. `cusers.downloadGroupMembers` belongs to identity |
| Edit User form and its tabs (Basic, Address Information, Group Memberships, Interests, Extended Attributes, Advanced, Content) | `cusers.editUser`, `route` [admin/core/controllers/cusers.cfc:243-261,377-400]; `userManager.read` [core/mura/user/userManager.cfc:125-196]; `userDAO.read` [core/mura/user/userDAO.cfc:92-299] | `admin:cusers.edituser`, `admin:cusers.route` | carry. The inventory gives the `edituser` entry to identity, because opening it can clear login strikes; people serves its person data |
| Address book | `cusers.editAddress`, `updateAddress` [admin/core/controllers/cusers.cfc:284-288,355-375]; `userManager.createAddress`, `updateAddress` [core/mura/user/userManager.cfc:860-940]; `core/mura/user/addressBean.cfc` | `admin:cusers.editaddress`, `admin:cusers.updateaddress` | carry |
| Roster create and edit without a photo or extended attributes | `cusers.update` with `type=2` [admin/core/controllers/cusers.cfc:290-353]; `userManager.update`, `create` [core/mura/user/userManager.cfc:404-703]; `userDAO.create`, `update` [core/mura/user/userDAO.cfc:300-355,404-500] | `admin:cusers.update{type=2,action=add}`, `admin:cusers.update{type=2,action=update}` | carry, roster write protocol |
| Edit Profile without a photo or extended attributes | `ceditprofile.edit`, `update` [admin/core/controllers/ceditprofile.cfc:116-141] | `admin:ceditprofile.edit`, `admin:ceditprofile.update` | carry, roster write protocol. The inventory gives the `edit` entry to identity, because opening it can log the user in again |
| JSON API `user` and `address` entities: reads, `validate`, `pollState`, and saves without a photo or extended attributes | `registerEntity('user')`, `registerEntity('address')` [core/mura/client/api/json/v1/jsonApiUtility.cfc:86,92]; `userManager.save` [core/mura/user/userManager.cfc:372-402] | `api:` and `rest:` `user.findone`, `findall`, `findmany`, `findquery`, `findnew`, `findproperties`, `findpermissions`, `validate`, `save`, `~pollstate`, and the same for `address` without `~pollstate` | carry |
| Front-end favourites | `core/modules/v1/favorites/ajax/saveFavorite.cfm`, `deleteFavorite.cfm`, `deleteRSSFavorite.cfm` | `cfm:/core/modules/v1/favorites/ajax/savefavorite.cfm`, `…/deletefavorite.cfm`, `…/deleterssfavorite.cfm` | carry |
| Person archive (seam 1 producer) | `legacy-fixtures/cfml/modules/people.cfc`; `legacy-fixtures/sql/people/100_person_archive.sql` | `fixture:people/persons/{id}/archive@post`, `fixture:people/persons/{id}/archive@get` | carry |
| User delete, photo, extended-attribute file and address-delete branches | As above, branches selected by `action=Delete`, `newFile` non-empty or `removePhotoFile=true`, or a posted `extendSetID` (`gateway/cutover/variants.json`) | [Not built here](#not-built-here) | decision, withheld |
| Public profile create and update | `doaction=createprofile`, `doaction=updateprofile` [core/mura/Handler/standardEventsHandler.cfc:521-640] | `page:createprofile`, `page:updateprofile` | decision, withheld; legacy-rendered |

## Owned data

Schema `people`, created by `opt2-db bootstrap` (`migration/src/db-bootstrap/`) with three roles:

| Role | Use |
|---|---|
| `people_owner` | `NOLOGIN`; owns the schema and every object, and FORCE RLS applies to it |
| `people_app` | Runtime DML only; the service's `PG_USER` |
| `people_migrator` | Applies `db/migrations/*.sql` after `SET ROLE people_owner` |

No role has `BYPASSRLS` or `SUPERUSER`.

Units, as split in [`opt2/table-ownership.json`](../../opt2/table-ownership.json):

| Legacy table | Unit | Rows and columns | Rule step |
|---|---|---|---|
| `tusers` | `people.person` | `Type = 2`, keyed by `UserID`, `SiteID`: `GroupName`, `Fname`, `Lname`, `Email`, `Company`, `JobTitle`, `mobilePhone`, `Website`, `subType`, `Ext`, `ContactForm`, `Subscribe`, `notes`, `description`, `interests`, `keepPrivate`, `photoFileID`, `IMName`, `IMService`, `tags`, `created`, `LastUpdate`, `LastUpdateBy`, `LastUpdateByID` | 1 |
| `tuseraddresses` | `people.user_address` | Rows of `Type = 2` users | 1 |
| `tusersinterests` | `people.user_interest` | Rows of `Type = 2` users; category ids kept, names read by projection | 1, 3 |
| `tuserstags` | `people.user_tag` | Rows of `Type = 2` users | 1 |
| `tusersfavorites` | `people.user_favorite` | Rows of `Type = 2` users; content ids kept | 1, 3 |
| `tclassextenddatauseractivity` | `people.extend_data_user_activity` | Rows of `Type = 2` users and their addresses | 1 |
| `tclassextend`, `tclassextendsets`, `tclassextendattributes`, `tclassextendrcsets`, `tclassextenddata` | `people.extend_subtype`, `people.extend_set`, `people.extend_attribute`, `people.extend_rc_set`, `people.extend_data` | Definitions and values whose subtype has `baseTable` `tusers` or `tusersaddresses` | 1 |
| `ttrash` | `people.trash` | Trashed users of `Type = 2`, their addresses, and user extensions | 1 |
| `synthetic.person_archive` (fixture) | `people.person_archive` | All | 1 |

Account, credential and login columns of the same `tusers` rows, and every `Type = 1` group row, belong to identity; the reverse projector reassembles each legacy `tusers` row from both owners. People writes Masa's audit columns `LastUpdate`, `LastUpdateBy` and `LastUpdateByID` as legacy does.

Other tables:

| Table | Holds |
|---|---|
| `people.roster_operation` | Durable intent of each roster write protocol operation |
| `people.group_name` | Projection of `identity.group.changed.v1`: group names and pool flags for the user screens |
| `people.person_tombstone` | Last `people.person.changed.v1` version of a deleted person, which a recreated person continues past |
| Platform tables | `tenant_registry`, `tenant_grant`, `changelog`, `unit_gate`, `open_operation`, `migration_batch`, `migration_watermark`, `outbox`, `inbox`, `consumer_aggregate_version`, `scheduled_task_queue`, `scheduled_task_queue_state` |

- Every tenant-owned table has `tenant_id uuid NOT NULL` and row-level security enabled and forced, with the `tenant_isolation` policy on `app.tenant_id`.
- Users of a shared user pool carry the pool site's (umbrella) tenant. A site's public and private pools are resolved from `tenant_registry`, never from a token: `tenant-a` reads its public pool in `umbrella` and its private pool in `tenant-a`.
- No table declares a foreign key, as in Masa.

## Roster write protocol

Every carried write that touches identity's columns (roster create and edit, Edit Profile, JSON API `user.save`) runs this protocol (AAP 0.4.3):

1. People commits the intent to `people.roster_operation`; a second operation on the same user waits up to 10 s, then answers the legacy-shaped 503.
2. Identity `…/operations/{operationId}:prepare` validates the account part and returns legacy's validation errors unchanged; people then commits the person rows with their before-image; identity `…:commit` applies the account part; people marks the operation `done` and calls `…:finish`.
3. Until `done` the user is closed to every other reader and writer (up to 10 s wait, then the legacy-shaped 503), and its outbox and changelog rows are published or projected only after `done`, both owners' changes together.
4. A 503 leaves no change on either side: people restores its before-image and identity aborts or reverts. Once identity's commit is confirmed, people finishes and answers success.
5. The `people-outbox-sweep` recovery hook resolves operations left open for over 30 s. One left without identity for 5 minutes becomes `halted`; an operator resolves it with `opt2-people resolve-operation <operationId>`.

## Routes

Every route declares `config.opt2.requires` or `config.opt2.public`; anything else fails start-up. Public legacy routes apply Masa's own checks inside the handler. [`contracts/openapi.yaml`](contracts/openapi.yaml) lists every route with its roles and route keys.

### Legacy routes

| Route key(s) | Path | Committed state |
|---|---|---|
| `api:` and `rest:` `user.*`, `address.*` | `/_api/{json,ajax,rest}/v1[/{siteid}[/…]]`, matched in any letter case | `legacy` |
| `cfm:/core/modules/v1/favorites/ajax/*.cfm` | The three favourites templates | `legacy` |
| `fixture:people/persons/{id}/archive@post` | `POST /legacy-fixtures/cfml/api.cfm/people/persons/{userId}/archive` | `target` in `v0002`; `legacy` in `v0001` and `v0003` |
| `fixture:people/persons/{id}/archive@get` | `GET` on the same path | `legacy` |
| The carried `admin:cusers.*` and `admin:ceditprofile.*` keys of [Masa features replaced](#masa-features-replaced) | Rendered by `web/` from the `/v1` and `/v2` APIs below | `legacy` |

The state is the one in `gateway/cutover/versions/v0001.json` to `v0003.json`. Most entries stay on legacy because their groups' units have Masa start-up writers (the bundle deploy in `core/mura/publisher.cfc`) that are not on the prevented-writer list (`gateway/src/cutover/prevented-writers.ts`). The person, address, interest and tag units also share `grp:identity.credential` with identity's units, since roster create and edit write both owners. Read entries move only when every people unit is `target`-authoritative. The archive group (`people.person_archive` with `timesheets.blackout`) moves in `v0002`, and `v0003`, the roster rollback rehearsal, returns it to legacy.

### `/v1` and `/v2` APIs

`web/src/screens/{cusers,ceditprofile}/` calls these through the gateway with the session's user token.

| Method and path | Serves | Requires |
|---|---|---|
| `GET /v1/users/groups` | `admin:cusers.list` | `s2`, `site-admin`, `m:008` |
| `GET /v1/users`, `GET /v2/users` | `admin:cusers.listusers` | as above |
| `GET /v1/users/search`, `GET /v2/users/search` | `admin:cusers.search` | as above |
| `GET`, `POST /v1/users/advanced-search`, `GET`, `POST /v2/users/advanced-search` | `admin:cusers.advancedsearch` | as above |
| `GET /v1/users/advanced-search.csv` | `admin:cusers.advancedsearchtocsv` | as above |
| `GET /v1/users/download` | `admin:cusers.download` | as above |
| `GET /v1/users/edit` | `admin:cusers.edituser` | as above |
| `POST /v1/users:update` | `admin:cusers.update{type=2,action=add}`, `{type=2,action=update}`, under the submitted `userid` as CSRF context | as above |
| `GET /v1/users/address` | `admin:cusers.editaddress` | as above |
| `POST /v1/users/addresses:update` | `admin:cusers.updateaddress`, under CSRF context `updateaddress<userId>` | as above |
| `GET /v1/users/route` | `admin:cusers.route` | as above |
| `GET /v1/profile` | `admin:ceditprofile.edit` | `system-user`, `member`, `s2`, `site-admin` |
| `POST /v1/profile:update` | `admin:ceditprofile.update`, under the default CSRF context | as above |

The `/v2/` list routes answer only the page `nextn` selects. A caller holding `m:008` without `site-admin` or `s2` also needs `m:000` (Site Manager) on the site, as `cusers.before` requires [admin/core/controllers/cusers.cfc:90-124], and is otherwise refused with legacy's back redirect.

### Internal and managed routes

| Method and path | Transport | Requires | Does |
|---|---|---|---|
| `GET /internal/v1/users/current` | service | `service:identity` | The token's own user, for identity's JSON API `findCurrentUser` |
| `POST /internal/v1/migration/apply`; `GET /internal/v1/migration/export`, `changes`, `position`; `GET`, `POST /internal/v1/migration/watermark`; `POST /internal/v1/migration/gate` | service | `platform.migration` | Backfill and feed batches, canonical export, changelog, write position, watermarks, unit gates |
| `POST /internal/v1/events/people.programs-sites.site.changed.v1`, `POST /internal/v1/events/people.identity.group.changed.v1` | Pub/Sub push | `service:pubsub-invoker` | Event deliveries ([Events](#events)) |
| `POST /internal/v1/outbox/sweep` | Cloud Tasks | `service:tasks-invoker` | The `people-outbox-sweep` chain: creates the next task, publishes unpublished outbox rows, then recovers open roster operations |
| `POST /internal/v1/task-queues/{queue}/pause`, `resume`, `ensure` | service | `platform.migration`, `platform.operator` | Queue control for the queues people creates tasks on |
| `GET /healthz` | service | public | Liveness |

## Not built here

- **Withheld** (decision list, [`opt2/decision-list.md`](../../opt2/decision-list.md)). They keep running on legacy, inside write windows once their units move. The JSON API answers a withheld key with the legacy-shaped 503 without executing it.
  - User delete: `admin:cusers.update{type=2,action=delete}`, `api:user.delete`, `rest:user.delete`.
  - Photo saves (`newFile` non-empty or `removePhotoFile=true`): `admin:cusers.update{photo}`, `admin:ceditprofile.update{photo}`, `api:user.save{photo}`, `rest:user.save{photo}`.
  - Extended-attribute saves, which can store files through strategies-content: `admin:cusers.update{type=2,action=add,extdata}`, `admin:cusers.update{type=2,action=update,extdata}`, `admin:ceditprofile.update{extdata}`, `admin:cusers.updateaddress{extdata}`, and `api:`/`rest:` `user.save{extdata}` and `address.save{extdata}`.
  - Address delete: `admin:cusers.updateaddress{action=delete}`, `api:address.delete`, `rest:address.delete`.
  - `admin:cusers.update` without a request-decidable type, and the public `page:createprofile` and `page:updateprofile`.
- **`admin:cusers.loadextendedattributes`.** People serves extended-attribute values but no class-extension definitions, so `web/` fails this fragment closed and it stays on legacy. Class-extension screens (`cextend`) and trash (`ctrash`) are withheld under programs-sites.

## Legacy behaviour kept on purpose

Reproduced as Masa shows it ([`opt2/reports/pre-existing-defects.md`](../../opt2/reports/pre-existing-defects.md)):

- The new-user form defaults to Member: a new person has `isPublic = 1` [core/mura/user/userBean.cfc:154].
- Admin dates keep legacy's mask, which prints the day of the year (`10/302/2026`); `web/` formats people's stored timestamps with it.

Open `preserve` entries ([`opt2/exceptions-list.md`](../../opt2/exceptions-list.md)): `EX-ROSTER-POOLMOVE`, a roster edit that would move a user to the other user pool, which the target refuses with 503 and no change; `EX-ADMIN-DEBUGPAGE`, an admin runtime error, which the target answers with the legacy error page at 503.

## Events

People writes each event to `people.outbox` in the transaction of the change, publishes it after commit, and re-publishes anything left behind through the `people-outbox-sweep` chain. The ordering key is the person's id.

| Topic | Kind | Carries | Consumers |
|---|---|---|---|
| `people.person.changed.v1` | `state` | Full state of one person's people-owned columns; `aggregateVersion` is `people.person.row_version` | identity → `identity.person_contact` |
| `people.person.archived.v1` | `process`, `x-opt2-tenant-fanout: userPool` | `personId`, `siteId`, `effectiveFrom` | timesheets → `timesheets.blackout` in the person's tenant and every tenant that pools its users there |

Migration applies emit only `people.person.changed.v1`, never `people.person.archived.v1`.

Consumed:

| Topic | Subscription | Fills |
|---|---|---|
| `programs-sites.site.changed.v1` | `people.programs-sites.site.changed.v1` | `people.tenant_registry`: each site's tenant and pools |
| `identity.group.changed.v1` | `people.identity.group.changed.v1` | `people.group_name` |

Service calls go over HTTP only, through the service-kit client (10 s timeout, no automatic retries): identity for the roster account operations and account, membership, group and session reads; strategies-content (`/internal/v1/files:lookup`) for the file extension of user photos.

## Configuration and running

- **Environment.** `baseEnvSchema` of `@opt2/platform/service-kit` ([`platform/README.md`](../../platform/README.md#configuration)): `PORT`, `OPT2_SERVICE_NAME=people`, `OPT2_ENV`, `PG_HOST`, `PG_PORT`, `PG_DATABASE`, `PG_USER=people_app`, `PG_PASSWORD`, `OPT2_DB_AUTH`, `CLOUD_SQL_INSTANCE`, `PUBSUB_EMULATOR_HOST`, `GOOGLE_CLOUD_PROJECT`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OPT2_JWKS_URL`, `OPT2_TOKEN_ISSUER`, `OPT2_TOKEN_AUDIENCE`, `OPT2_GATEWAY_URL`, `OPT2_MIGRATION_URL`, `OPT2_SERVICE_URLS` (naming identity and strategies-content), `OPT2_STATE_DIR`, `OPT2_TASKS_ADAPTER`, `OPT2_STORAGE_ADAPTER`, `TZ`. `OPT2_FAULT=roster:<step>` makes the process exit at a roster protocol step, for the fault suites only.

```sh
npm ci                  # postinstall builds ../../platform
npm run build           # contract types into src/generated/, then tsc into dist/
npm test                # vitest with coverage, >= 90% statements
npm run test:contract
npm run test:security
PORT=8112 npm start     # normally started by harness/repro/up.sh
```

`test/contract` and `test/security` need nothing external. Suites that build the app over PostgreSQL 16 read `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD` and `PG_DATABASE`, create a throwaway schema and roles through `@opt2/platform/testing`, and skip when the database is unreachable. Golden scenarios proving this service: GS-ID-05, GS-PE-01 to GS-PE-06, GS-PUB-03 and the rollback rehearsal GS-PE-RH-01 to GS-PE-RH-03.

- **Operator CLI.** From this folder, `npx opt2-people resolve-operation <operationId> [--to rolled-back|done] [--tenant <uuid>]` resolves one roster operation from its and identity's recorded states; a halted operation needs `--to`. It reads the service's own environment and exits 0 when resolved, 1 when not, 2 on a usage or environment error.
- **Local.** `harness/repro/up.sh` starts the service natively with `PORT=8112` and `PG_USER=people_app`, after `opt2-db bootstrap --target local` has created the schema and roles.
- **Cloud.** Cloud Run with `min_instance_count = 0`, internal-only ingress, Cloud SQL IAM database authentication (`OPT2_DB_AUTH=iam`) as a member of `people_app`, and the OpenTelemetry Collector sidecar (`infra/terraform/`, plan only).
