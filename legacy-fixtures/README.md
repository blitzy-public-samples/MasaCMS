**SYNTHETIC MODULE**

# Legacy fixtures

Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

These fixtures are a synthetic legacy oracle for the people archive, which has no Masa equivalent, and the seed loader for the generated dataset. Golden outputs are captured from the archive endpoint exactly as from Masa (AAP 0.7.2); GS-PE-03 and GS-PE-RH-03 are its parity tests against `services/people`.

## What is never touched

- No Masa table, procedure, trigger, Change Tracking or CDC object is created or altered. The Masa licence header forbids altering default database objects (`Application.cfc:59`).
- All fixture DDL lives in the new schema `synthetic`.
- Writes into Masa tables are data only, made by `cfml/seed.cfm` through Masa's own managers. The people archive route writes fixture tables only.
- The `opt2_sync` schema in the same database belongs to `migration/`, not to the fixtures.

## Layout

| Path | Role |
|---|---|
| `load-fixtures.sh` | Capability check, SQL load, `${OPT2_STATE_DIR}/fixtures.json` |
| `sql/000_schemas.sql` | Schema `synthetic` |
| `sql/people/100_person_archive.sql` | Table `synthetic.person_archive` |
| `cfml/Application.cfc` | Joins Masa's application. Serves only `api.cfm` and `seed.cfm` in this folder (anything else 404 with an empty body), and never triggers a Masa reload |
| `cfml/api.cfm` | Front controller for the module routes |
| `cfml/seed.cfm` | Seed loader for the generated dataset |
| `cfml/lib/envelope.cfc` | Masa envelope, error map and value formats |
| `cfml/lib/auth.cfc` | Masa-session authentication, CSRF validation and site resolution |
| `cfml/modules/people.cfc` | The `people` module handler |
| `seed/` | Fixed-seed dataset generator, package `@opt2/legacy-fixtures-seed` |

## Web-root placement

- The repository root is the legacy web root, so the fixtures are served at `/legacy-fixtures/cfml/`.
- `cfml/Application.cfc` is `extends="muraWRM.Application"`. `/muraWRM` is a server-level ColdFusion mapping to the repository root, saved by `harness/repro/lib/legacy-start.sh`.
- Masa computes `this.name` from its own template path (`core/appcfc/applicationSettings.cfm:173`). The fixtures therefore share Masa's application scope, session scope and datasource, and no Masa file changes.

## Loading

`harness/repro/up.sh` runs `load-fixtures.sh` (no arguments, `-h` for help) at seeding. It then loads the dataset that `seed/` generated through `cfml/seed.cfm`. `--check-only` runs step 1 and writes `fixtures.json` (step 3) without loading anything.

`load-fixtures.sh` steps:

1. **Capability check.** `sqlcmd` reaches `${MURA_DATABASE}` with `CREATE SCHEMA` permission, or the `synthetic` schema already exists. Any failure is a reason in `fixtures.json`, and nothing is loaded.
2. **SQL load.** Every `sql/**/*.sql` file runs in `LC_ALL=C` path order.
3. **Status.** `${OPT2_STATE_DIR}/fixtures.json` is written atomically. It reads `available: false`, `in progress` while a run is under way, and an interrupted run (`SIGINT`, `SIGTERM`) leaves `error: <step>: interrupted`.

| Variable | Use |
|---|---|
| `MURA_DATABASE`, `MURA_DBUSERNAME`, `MURA_DBPASSWORD` | Required. The legacy database; the password reaches `sqlcmd` only through `SQLCMDPASSWORD` |
| `MURA_DBHOST`, `MURA_DBPORT` | Default `127.0.0.1`, `1433` |
| `OPT2_STATE_DIR` | Default `$HOME/.opt2/state`. Must be absolute and outside the checkout. Runs sharing it take turns (`flock` on `fixtures/lock`) |
| `SQLCMD` | Optional explicit `sqlcmd` executable. A set `SQLCMD` that is not an executable file is an unexpected error, with no fallback to `PATH` |

Exit status: 0 once `fixtures.json` is written (whether available or not), 1 on an unexpected error, an unusable `SQLCMD` or an interrupt (also recorded as `available: false`), 2 on a usage or `OPT2_STATE_DIR` error.

`fixtures.json` is `{ "available": true|false, "reason": "<text>", "checkedAt": "<ISO-8601 UTC>" }`. Both repro commands read it. With `available: false` (AAP 0.7.6):

| Step | Effect |
|---|---|
| `up.sh` seed | Masa seed only; the empty `synthetic.person_archive` goes to `services/people` through `seed --direct` |
| Cut-over versions | The committed versions apply; their fixture routes are absent from legacy |
| `test-all.sh` stage 7 | The people archive step is reported `skipped: fixtures unavailable` |
| Stage 8 rollback | Rehearsed with create and edit only; the archive leg is reported unmet |
| Reports and exit | `test-all.sh` exits 2 |

### `seed.cfm`

- `POST /legacy-fixtures/cfml/seed.cfm?part=<part>[&offset=<n>][&limit=<n>][&fixtures=false]`, with a dataset part file as the JSON body (`rows`, `offset`, and `credentials` for parts that need them).
- Only a logged-in S2 session from loopback is admitted (otherwise 401); any other method answers 400 `invalidMethodCall`.
- Each POST needs a single-use Masa CSRF pair from `generateCSRFTokens` with context `opt2-seed`, sent only as the `X-csrf_token` and `X-csrf_token_expires` headers. A missing, used, expired or wrong-context pair answers 400 `invalidTokens`. A body whose `Content-Type` is not `application/json` (parameters such as `charset` aside) answers 400 `invalidParameters`. Neither writes anything.
- Masa parts `sites`, `groups`, `users`, `memberships`, `categories`, `content`, `files`, `oauthClients`, `formResponses`, `commenters` and `comments` (bare or `masa.<name>`) go through Masa managers. `formResponses` rows go through `dataCollectionManager.update`, the data manager's Update path, which keeps their `responseID` and `entered`; `commenters` through the commenter bean; `comments` through `contentManager.saveComment` without notification, each kept on its seeded commenter rather than one keyed to the seeding admin. The only fixture part, `fixtures.synthetic.person_archive` (or `fixtures:synthetic.person_archive`), is seeded empty: it answers `{total: 0, inserted: 0}`, and 400 `invalidParameters` when it holds rows. Any other fixture part answers 400 `invalidParameters`.
- `offset` is a dataset-wide row index, as in `manifest.json` and the part file. It defaults to the body's `offset`; one outside the part answers 400 `invalidParameters`. `limit` defaults to the rest of the part.
- With `fixtures=false`, fixture parts answer 400 `badRequest`.
- A Masa row's `siteID`, and each pool id of a `sites` row, must be a string of 1–25 ASCII letters, digits, `_` or `-`, as Masa's add-site form admits. Otherwise the part answers 400 `invalidParameters` naming the row offset and field, and writes nothing.
- A `files` row's `fileID` must be a CF UUID, and its `filename` a name without `/`, `\` or control characters ending in `.png` or `.pdf`, the generator's file types. Its stored copy must resolve inside the file pool's `cache/file` directory. Otherwise the part answers 400 `invalidParameters` naming the row offset, and writes nothing.
- The response reports `{part, offset, limit, total, inserted}`, so a repeated part inserts nothing new. A content node holding only its leading versions gets the rest and counts as inserted; one whose stored history differs answers 400 `invalidParameters`. Credentials are never echoed.
- A `users` or `oauthClients` part also brings existing seeded accounts to the credentials it carries, so a regenerated `credentials.json` holds after a reload; an account already on them is not rewritten.
- A `sites` row's `pageLimit` is the site's `tsettings.PageLimit`: passed to `settingsManager.create` for a new site, and set through `settingsManager.update` on an existing site whose limit differs. A row without one leaves Masa's limit as it is. A `pageLimit` that is not an integer from 1 to 2,147,483,647 answers 400 `invalidParameters` naming the row offset, and writes nothing.
- `harness/repro/lib/seed-legacy.mjs` posts every `manifest.json` part in order (fixture parts are skipped under `--fixtures false`), with `part`, `offset`, `limit` and `businessDate` (which `seed.cfm` ignores) from `manifest.json`, and `fixtures`. Before each POST, including the repeat after a re-login, it fetches a fresh `opt2-seed` pair in the same session.

## Routes

- Base: `/legacy-fixtures/cfml/api.cfm/`; path grammar `<module>/<resource>[/<id>][/<action>][/<tail>]`, where `<module>` is `people`. Any other path, another module's included, answers 404 `notFound` with envelope `method` `invalid`.
- Parameters merge as Masa's JSON API merges them: query, then form, then an `application/json` body, each overwriting the earlier. `X-HTTP-Method-Override` replaces the HTTP method.
- A logged-in call with a method other than GET or HEAD needs a single-use Masa CSRF token from `generateCSRFTokens`, with the route's `{id}` segment as context. It travels as `csrf_token` and `csrf_token_expires` parameters, or as `X-csrf_token` and `X-csrf_token_expires` headers, which win over the parameters. A missing, used, expired or wrong-context token answers 400 `invalidTokens`.
- `siteid` defaults to the session user's site, else `default`; routes use the site's canonical id (`TENANT-A` resolves to `tenant-a`). An unknown site answers 400 `invalidParameters`. The envelope `method` is `<module>.<resource>[.<action>][.<tail>]`.
- Every route is a carry route to its module's service by definition (AAP 0.5.6). The gateway keys it with `platform/src/legacy-compat/route-key.ts` rule 5: `fixture:<module>/<resource>[/{id}][/<segment>…]@<method>`, for example `fixture:people/persons/{id}/archive@post`, with the override honoured.

### people → `services/people`

| Method | Path | Required group | Notes |
|---|---|---|---|
| POST | `people/persons/{userId}/archive` | S2, or the site's private-pool `Admin` group | `effectiveFrom`. Inserts `synthetic.person_archive`. A repeated archive answers 400 `badRequest` |
| GET | `people/persons/{userId}/archive` | as above | The archive record; 404 when there is none |

Both answer 404 unless `{userId}` is a Type 2 user in the site's public or private user pool.

## Authorisation

- The Masa session authenticates (`cfml/lib/auth.cfc`); no login answers 401 `authorization`.
- The people archive requires S2 or membership of the site's private-pool `Admin` group, the target's `s2` or `site-admin`; a logged-in user without it answers 403 `forbidden`.
- A write's CSRF token (see Routes) is validated after that check and before the route's own 404 and 400 answers.

## Formats

- Responses use the Masa JSON envelope `{apiversion, method, params, data}`, built by `cfml/lib/envelope.cfc` with Masa's own `mura.jsonSerializer`. As in Masa, `params` is dropped when `suppressAPIParams` is on (the default), `data` is flattened when the data namespace is off, the content type is `application/json; charset=utf-8`, and `ETag` is `hash()` of the body.
- Errors replace `data` with `error: {code, message}`:

| Status | Error type | `error.code` | Raised for |
|---|---|---|---|
| 400 | `invalidParameters`, `invalidMethodCall`, `badRequest` | `invalid_request` | Bad or missing parameters, unknown site, repeated archive |
| 400 | `invalidTokens` | `invalid_request` | A logged-in write without a valid CSRF token; the message is `Invalid CSRF tokens` |
| 401 | `authorization` | `invalid_request` | No Masa login |
| 403 | `forbidden` | `invalid_request` | Not a site administrator |
| 404 | `notFound` | `invalid_request` | Unknown route, or a person outside the request site |
| 500 | `server_error` | `server_error` | Unhandled exception, logged as a `log-record.v1` line without request values |

- Ids are 35-character CF UUIDs. Timestamps are `yyyy-mm-ddTHH:nn:ss` in the legacy server's time zone, and NULL is an empty string (AAP 0.5.5).

## Seed

`seed/` generates the one dataset both sides start from (AAP 0.8.6): legacy through `cfml/seed.cfm`, the target only through backfill or `--direct`.

- `seed/seed.config.json` fixes `seed: 20260601` and `businessDate: 2026-06-30`, the default `${asOf}` of golden scenarios. A binding named `asOf` or a step's literal `asOf` overrides it.
- `reserved.rehearsal` reserves 10 `tenant-a` persons in no group and the usernames `rh-create-01` to `rh-create-10`. Only GS-PE-RH-01/02/03 may use them; `harness/src/golden/coverage.ts` fails on any other use.
- `scenarioPasswords` names the passwords golden scenarios post for accounts they create; the generator reads only `gs-id-09`, `gs-pe-01` and `gs-pe-rh-01` and ignores any other name. `npm run generate` gives each name a random password, kept across runs, in the credentials' `generated` section, which `${secret:generated:<name>}` reads. `harness/test/golden/catalogue-seed-refs.test.ts` fails when the list and the catalogue's names differ.
- Each seeded site has the domain `<siteID>.localhost` and the alias `localhost`. Public requests to `<siteID>.localhost` bind to the site; its admin pages served on `localhost` call the JSON API on their own origin. Host `localhost` still binds to `default`, whose `orderNo` is 1.
- The retired keys `roleGroups`, each site's `programId` and the counts of removed fixture modules are accepted and ignored. The first ten `groups` and `systemUsers` slots of a site with system users are retired role-group slots, drawn but not generated, so every other row keeps its values.
- A site's `pageLimit` sets its Masa page limit; a site without one keeps Masa's default, 1,000. Masa hides the new-content and upload forms once a site's pages reach the limit, so `tenant-a` sets 10,000, and a site whose `contentNodes` do not stay below its limit is rejected.

| Site (tenant) | Pools | Size |
|---|---|---|
| `umbrella` | Pool site | 1,000 pooled members, 100 categories, pooled files, 10 content nodes with versions |
| `tenant-a` | `publicUserPoolID`, `categoryPoolID`, `filePoolID`, `displayPoolID` = `umbrella`; own private user pool and content | 1,990 system users and 40 groups, 5,000 content nodes with versions |
| `tenant-b` | None | 190 users, 300 content nodes |
| `default` | As installed | The installed `admin` (S2) and `qa_editor` accounts; not generated |

- Each of `tenant-a` and `tenant-b` holds one Form, `OPT-2 Seed Contact Form`, placed in region 2 of its host page `OPT-2 Seed Contact Page`, with 12 form responses. The host page carries 6 comments from 4 commenters: two public-pool members keyed by user id, then two visitors keyed by e-mail. The fifth comment replies to the second, and the last awaits approval. GS-CO-20 reads the comments.

Commands, from `seed/`:

| Command | Effect |
|---|---|
| `npm ci && npm run build && npm test` | Install (the `postinstall` builds `../../platform`), compile, run the tests with coverage |
| `npm run typecheck` | Type-checks `src/`, `test/` and `vitest.config.ts` through `test/tsconfig.json`, without emitting |
| `npm run lint` | ESLint with typescript-eslint recommended over the package (`eslint.config.mjs`) |
| `npm run test:contract` | `test/contract/`: the fixture table registry and direct mode's apply bodies against the fixture DDL |
| `npm run test:security` | `test/security/`: credential generation and owner-only storage |
| `npm run generate` | Writes `dataset.json`, its part files and `manifest.json` to `${OPT2_STATE_DIR}/seed/` (`--out` overrides), plus `credentials.json` there; only the default output also writes `${OPT2_STATE_DIR}/secrets/seed-credentials.json` |
| `npm run generate:direct` | `--direct`: sends the fixture rows of the `dataset.json` that `npm run generate` wrote (same `--out` default) to the owning services' `/internal/v1/migration/apply` through `OPT2_SERVICE_URLS`, signed as the `migration` workload with the local key pair. The seed holds no fixture rows, so it sends nothing |

- The dataset is identical on every run; credentials are random, written with mode 0600 and never committed. A run keeps every secret `${OPT2_STATE_DIR}/secrets/seed-credentials.json` already holds for the same site and username, OAuth client ID or scenario name, so the seed legacy holds stays valid; it fails with exit 1 when that file is not valid seed credentials.
- `OPT2_SERVICE_URLS` is a JSON object of owning service name to base URL, with the key `people`. With the ports in `harness/repro/ports.env`: `{"people":"http://127.0.0.1:8112"}`. Direct mode checks, before it reads the signing keys or sends anything, that every value is an http(s) URL and that every owner of a fixture table with rows has one; otherwise it exits 2.
- The local key pair is `${OPT2_STATE_DIR}/secrets/token-signing-private.pem` and `token-signing-public.pem`, generated by the secrets step of `harness/repro/up.sh`. `npm run generate` writes credentials only, never these keys; without them direct mode fails before its first batch.
- Both commands refuse an output directory inside the checkout; `generate` also refuses an `OPT2_STATE_DIR` inside it.
- Exit status: 0 when done; 1 when a run fails (in direct mode a missing or altered dataset, a missing key, or an owner's error answer or transport failure, which stops the run at that batch); 2 on a usage error, a missing or invalid `OPT2_SERVICE_URLS`, one without a URL for an owner of a table with rows, or a refused directory.
