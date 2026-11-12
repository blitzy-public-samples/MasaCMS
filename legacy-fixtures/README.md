**SYNTHETIC MODULE**

# Legacy fixtures

Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

These fixtures are a synthetic legacy oracle for the six synthetic modules (communications, reporting, surveys, timesheets, finance and e-signature) and for the people archive → timesheets blackout seam. None of them has a Masa equivalent. Golden outputs are captured from these endpoints exactly as from Masa (AAP 0.7.2). The GS-TS, GS-FI, GS-SU, GS-RE, GS-CM and GS-ES scenarios are the parity tests of the matching target services (AAP 0.7.6).

## What is never touched

- No Masa table, procedure, trigger, Change Tracking or CDC object is created or altered. The Masa licence header forbids altering default database objects (`Application.cfc:59`).
- All fixture DDL lives in the new schemas `synthetic`, `Program_1` and `Program_2`.
- Writes into Masa tables are data only, made by `cfml/seed.cfm` through Masa's own managers. The people archive route writes fixture tables only.
- The `opt2_sync` schema in the same database belongs to `migration/`, not to the fixtures.

## Layout

| Path | Role |
|---|---|
| `load-fixtures.sh` | Capability check, SQL load, transition tables, `${OPT2_STATE_DIR}/fixtures.json` |
| `sql/000_schemas.sql` | Schemas `synthetic`, `Program_1`, `Program_2`. Requires compatibility level 130 or higher (`OPENJSON`, `STRING_SPLIT`) |
| `sql/010_program_site.sql` | `synthetic.program_site` |
| `sql/020_load_transitions.sql` | `synthetic.transition_rule` and `synthetic.usp_load_transitions` |
| `sql/<module>/` | `communications`, `esignature`, `finance`, `people`, `reporting`, `surveys`, `timesheets`: tables (`1xx`), procedures (`2xx`), seed procedure (`300_seed`) |
| `sql/<module>/*.program.sql` | Per-program files, run once per `Program_<id>` with the `sqlcmd` variables `PROGRAM_SCHEMA` (`Program_<id>`) and `PROGRAM_ID` |
| `cfml/Application.cfc` | Joins Masa's application. Serves only `api.cfm` and `seed.cfm` in this folder (anything else 404 with an empty body), and never triggers a Masa reload |
| `cfml/api.cfm` | Front controller for every module route |
| `cfml/seed.cfm` | Seed loader for the generated dataset |
| `cfml/lib/envelope.cfc` | Masa envelope, error map, paging and value formats |
| `cfml/lib/auth.cfc` | Masa-session authentication, role-group authorisation, CSRF validation, site and program resolution |
| `cfml/modules/<module>.cfc` | One handler per module: `people`, `timesheets`, `finance`, `surveys`, `reporting`, `communications`, `esignature` |
| `seed/` | Fixed-seed dataset generator, package `@opt2/legacy-fixtures-seed` |

SQL objects per module (`Program_N.` marks per-program objects):

| Module | Tables | Procedures |
|---|---|---|
| people | `synthetic.person_archive` | `synthetic.usp_person_archived_blackout` (in `sql/timesheets/`) |
| timesheets | `synthetic.timesheet_transition`; `Program_N.timesheet`, `timesheet_day`, `approval_action`, `blackout` | `Program_N.usp_timesheet_status`, `usp_timesheet_status_list`, `usp_timesheet_day_action`, `usp_apply_blackout`, `usp_seed_timesheets` |
| finance | `synthetic.finance_transition`; `Program_N.finance_record`, `finance_record_version`, `finance_attachment` (`varbinary(max)`), `finance_rollup` | `Program_N.usp_finance_create`, `usp_finance_transition`, `usp_finance_rollup`, `usp_seed_finance` |
| surveys | `synthetic.survey`, `survey_schedule`, `survey_reminder`, `survey_target`, `survey_response` | `synthetic.usp_survey_bulk_target`, `usp_seed_surveys` |
| reporting | `synthetic.export_definition`, `export_job` | `synthetic.usp_export_job_transition`, `usp_seed_reporting` |
| communications | `synthetic.message_template`, `message`, `delivery_status` | `synthetic.usp_seed_communications` |
| esignature | `synthetic.signature_request`, `signature`, `audit_entry` | `synthetic.usp_audit_append`, `usp_seed_esignature` |

## Web-root placement

- The repository root is the legacy web root, so the fixtures are served at `/legacy-fixtures/cfml/`.
- `cfml/Application.cfc` is `extends="muraWRM.Application"`. `/muraWRM` is a server-level ColdFusion mapping to the repository root, saved by `harness/repro/lib/legacy-start.sh`.
- Masa computes `this.name` from its own template path (`core/appcfc/applicationSettings.cfm:173`). The fixtures therefore share Masa's application scope, session scope and datasource, and no Masa file changes.

## Programs

- `synthetic.program_site` maps program 1 to site `tenant-a` (`Program_1`) and program 2 to site `tenant-b` (`Program_2`).
- Each `Program_<id>` schema holds the same timesheet and finance table set. `cfml/lib/auth.cfc` resolves the schema from the request site.
- The target folds these tables into tenant-column tables with a `legacy_program_id` column (AAP 0.4.3, 0.8.1).

## Loading

`harness/repro/up.sh` runs `load-fixtures.sh` (no arguments, `-h` for help), then loads the dataset that `seed/` generated through `cfml/seed.cfm`.

`load-fixtures.sh` steps:

1. **Capability check.** `sqlcmd` reaches `${MURA_DATABASE}` with `CREATE SCHEMA` permission (or the three schemas already exist); the `cfpm` packages `spreadsheet`, `document`, `mail` and `scheduler` are installed; the Mailpit API and SMTP listener answer. Any failure is a reason in `fixtures.json`, and nothing is loaded.
2. **SQL load.** Every `sql/**/*.sql` file runs in `LC_ALL=C` path order. A `*.program.sql` file runs once per program listed in `synthetic.program_site`.
3. **Transition tables.** `opt2/reports/state-machines/finance.json` and `timesheets.json` are loaded through `synthetic.usp_load_transitions` into `synthetic.finance_transition` and `synthetic.timesheet_transition` (plus the blackout rule in `synthetic.transition_rule`), and the row counts are checked. The fixture procedures enforce these tables, so the oracle and the target share one lifecycle definition (AAP 0.4.5).
4. **Status.** `${OPT2_STATE_DIR}/fixtures.json` is written atomically.

| Variable | Use |
|---|---|
| `MURA_DATABASE`, `MURA_DBUSERNAME`, `MURA_DBPASSWORD` | Required. The legacy database; the password reaches `sqlcmd` only through `SQLCMDPASSWORD` |
| `MURA_DBHOST`, `MURA_DBPORT` | Default `127.0.0.1`, `1433` |
| `OPT2_STATE_DIR` | Default `$HOME/.opt2/state`. Must be absolute and outside the checkout |
| `MAILPIT_API_URL`, `SMTP_HOST`, `SMTP_PORT` | Mailpit check. Default `http://127.0.0.1:8025`, `127.0.0.1`, `1025` |
| `OPT2_LEGACY_SERVER_NAME` | CommandBox server whose `cfpm` list is read. Default `opt2-legacy` |
| `SQLCMD`, `CFPM_CMD` | Optional explicit `sqlcmd` and `cfpm` executables |

Exit status: 0 once `fixtures.json` is written (whether available or not), 1 on an unexpected error (also recorded as `available: false`), 2 on a usage or `OPT2_STATE_DIR` error.

`fixtures.json` is `{ "available": true|false, "reason": "<text>", "checkedAt": "<ISO-8601 UTC>" }`. Both repro commands read it. With `available: false` (AAP 0.7.6):

| Step | Effect |
|---|---|
| `up.sh` seed | Masa seed only. The synthetic services are seeded directly from the same dataset with `seed --direct` |
| Cut-over versions | Fixture routes are absent from legacy. The synthetic services' own `/v1/` routes are `target` in `v0002`, with no legacy oracle |
| `test-all.sh` stages 3, 7 | Synthetic services are tested against their specification and generated state tables. Synthetic GS scenarios, both seams' legacy captures and the people archive step are reported `skipped: fixtures unavailable` |
| Stage 8 rollback | Rehearsed with create and edit only; the archive-to-blackout leg is reported unmet |
| Reports and exit | Parity is stated as covering four of ten services. `test-all.sh` exits 2 |

The ColdFusion process also reads these variables on its start command:

| Variable | Read by |
|---|---|
| `OPT2_GATEWAY_ORIGIN` | `surveys`: absolute `http(s)` origin that survey ACF tasks call back. Unset, scheduling answers `server_error` |
| `SMTP_HOST`, `SMTP_PORT`, `MAILPIT_API_URL` | `communications`: `cfmail` server and delivery lookup. Default `127.0.0.1`, `1025`, `http://127.0.0.1:8025` |

### `seed.cfm`

- `POST /legacy-fixtures/cfml/seed.cfm?part=<part>[&offset=<n>][&limit=<n>][&businessDate=<yyyy-mm-dd>][&fixtures=false]`, with a dataset part file as the JSON body (`rows`, `offset`, and `credentials` for parts that need them).
- Only an S2 session from loopback is admitted (otherwise 401); any other method answers 400 `invalidMethodCall`.
- Masa parts `sites`, `groups`, `users`, `memberships`, `categories`, `content`, `files` and `oauthClients` (bare or `masa.<name>`) go through Masa managers. Fixture parts `fixtures.<schema>.<table>` or `fixtures:<schema>.<table>` go through the module's `usp_seed_*` procedure.
- `offset` is a dataset-wide row index, as in `manifest.json` and the part file. It defaults to the body's `offset`; one outside the part answers 400 `invalidParameters`. `limit` defaults to the rest of the part.
- Finance parts (`Program_<id>.finance_record`, `finance_record_version`, `finance_attachment`) require `businessDate`, the dataset's `businessDate` in `manifest.json` (`2026-06-30` with the committed `seed.config.json`). It is the `@now` of the `usp_finance_rollup` run that follows in the same transaction. Missing or malformed, it answers 400 `invalidParameters`. Other parts ignore it.
- Example, the second of `tenant-a`'s three 1,000-row finance-record parts (`chunkRows: 1000`): `POST /legacy-fixtures/cfml/seed.cfm?part=fixtures.Program_1.finance_record&offset=1000&limit=1000&businessDate=2026-06-30`, with that part file (`array: fixtures.Program_1.finance_record`, `offset: 1000`) as the body.
- With `fixtures=false`, fixture parts answer 400 `badRequest`.
- The response reports `{part, offset, limit, total, inserted}`, so a repeated part inserts nothing new. Credentials are never echoed.
- `harness/repro/lib/seed-legacy.mjs` posts every `manifest.json` part in order (fixture parts are skipped under `--fixtures false`), with `part`, `offset`, `limit`, `businessDate` from `manifest.json`, and `fixtures`.

## Routes

- Base: `/legacy-fixtures/cfml/api.cfm/`; path grammar `<module>/<resource>[/<id>][/<action>][/<tail>]`. A path outside it answers 404.
- Parameters merge as Masa's JSON API merges them: query, then form, then an `application/json` body, each overwriting the earlier. `X-HTTP-Method-Override` replaces the HTTP method.
- A logged-in call with a method other than GET or HEAD needs a single-use Masa CSRF token from `generateCSRFTokens`, with the route's `{id}` segment as context (empty for collection routes such as `finance/records`). It travels as `csrf_token` and `csrf_token_expires` parameters, or as `X-csrf_token` and `X-csrf_token_expires` headers, which win over the parameters. A missing, used, expired or wrong-context token answers 400 `invalidTokens`. Task callbacks are exempt.
- `siteid` defaults to the session user's site, else `default`; routes use the site's canonical id (`TENANT-A` resolves to `tenant-a`). An unknown site answers 400 `invalidParameters`. The envelope `method` is `<module>.<resource>[.<action>][.<tail>]`.
- Every route is a carry route to its module's service by definition (AAP 0.5.6). The gateway keys it with `platform/src/legacy-compat/route-key.ts` rule 5: `fixture:<module>/<resource>[/{id}][/<segment>…]@<method>`, for example `fixture:people/persons/{id}/archive@post`, with the override honoured.
- In the tables below, "any of" lists the groups the module's gate admits; where an action names its own role, the procedure checks it against the transition table and answers 403 for the wrong role and 409 for an illegal state.

### people → `services/people`

| Method | Path | Required group | Procedure | Notes |
|---|---|---|---|---|
| POST | `people/persons/{userId}/archive` | S2, or the site's private-pool `Admin` group | `synthetic.usp_person_archived_blackout` | `effectiveFrom`. Inserts `synthetic.person_archive` and blacks out the person's open timesheet days in one transaction (seam 1). A repeated archive answers 400 `badRequest` |
| GET | `people/persons/{userId}/archive` | as above | — | The archive record; 404 when there is none |

Both answer 404 unless `{userId}` is a Type 2 user in the site's public or private user pool. The procedure blacks out days in every program whose site is the person's site or pools its users there.

### timesheets → `services/timesheets`

Gate: any of `timesheets.employee`, `timesheets.primary-approver`, `timesheets.secondary-approver`. `asOf` is a request parameter, so outputs are clock-independent.

| Method | Path | Required group | Procedure | Notes |
|---|---|---|---|---|
| GET | `timesheets/sheets` | gate | `usp_timesheet_status_list` | Paged; status, overdue flag and day counts |
| GET | `timesheets/sheets/{id}` | gate | `usp_timesheet_status` | Sheet, status fields and days |
| GET | `timesheets/sheets/{id}/status` | gate | `usp_timesheet_status` | — |
| POST | `timesheets/days/{id}/{submit\|primary-approve\|secondary-approve\|return\|resubmit}` | the action's role in `synthetic.timesheet_transition` | `usp_timesheet_day_action` | `comment`. A blackout day answers 409 `blackout` |

### finance → `services/finance`

| Method | Path | Required group | Procedure | Notes |
|---|---|---|---|---|
| GET | `finance/records` | any of `finance.preparer`, `finance.approver` | — | Paged |
| POST | `finance/records` | `finance.preparer` | `usp_finance_create`, `usp_finance_rollup` | `title`, `amount`, `period`. Starts IN-PROGRESS with version 1. Answers `invalidParameters` when the period's positive or negative amounts would sum past 999999999999999.9999 |
| GET | `finance/records/{id}` | any of preparer, approver | — | — |
| POST | `finance/records/{id}/{submit\|approve\|reject\|resubmit\|edit}` | the action's role in `synthetic.finance_transition` | `usp_finance_transition`, `usp_finance_rollup` | Each transition and edit writes a version row. An edit answers `invalidParameters` under the same period bound as create |
| GET | `finance/records/{id}/versions` | any of preparer, approver | — | — |
| GET | `finance/records/{id}/attachments` | any of preparer, approver | — | Metadata |
| POST | `finance/records/{id}/attachments` | `finance.preparer` | — | Multipart field `file` |
| GET | `finance/records/{id}/attachments/{aid}` | any of preparer, approver | — | Attachment bytes |
| GET | `finance/rollups` | any of preparer, approver | — | Paged `finance_rollup`, maintained by `usp_finance_rollup` |

### surveys → `services/surveys`

| Method | Path | Required group | Procedure | Notes |
|---|---|---|---|---|
| GET | `surveys/surveys` | `surveys.manager` | — | Paged |
| POST | `surveys/surveys` | `surveys.manager` | — | `title`; creates a DRAFT survey |
| GET | `surveys/surveys/{id}` | `surveys.manager` | — | Survey with schedule, reminders and targets |
| POST | `surveys/surveys/{id}/schedule` | `surveys.manager` | — | `launchAt`, `reminders[].offsetMinutes` (seam 2). Replaces the ACF tasks `opt2-survey-<id>-launch` and `opt2-survey-<id>-reminder-<n>`, addressed to `OPT2_GATEWAY_ORIGIN`. 409 unless DRAFT or SCHEDULED |
| POST | `surveys/surveys/{id}/targets/bulk` | `surveys.manager` | `usp_survey_bulk_target` | `targets`, a JSON array of site and group targets. Each needs an existing `siteID` and a `groupName` of at most 255 characters, else `invalidParameters` |
| GET | `surveys/surveys/{id}/responses` | `surveys.manager` | — | Paged |
| POST | `surveys/surveys/{id}/responses` | a logged-in member of `siteid`: S2, a private-pool user or a public-pool account of that site, which must own or be targeted by the survey (else 403) | — | `answers`. Stored under the survey's site with `respondentSiteID` = the verified `siteid` |
| GET | `surveys/surveys/{id}/tasks` | `surveys.manager` | — | Current ACF tasks with kind, callback route and offset |
| GET, POST | `surveys/surveys/{id}/launch` | task callback: `opt2TaskToken` | — | Marks the survey LAUNCHED once |
| GET, POST | `surveys/surveys/{id}/remind` | task callback: `opt2TaskToken` | — | `reminder=<n>`; stamps the reminder sent once |

The callbacks authorise by the per-schedule task token, whose SHA-256 is stored in `synthetic.survey_schedule`; a wrong token answers 403. The bridge's `scheduler.cfm` lists, pauses and deletes these tasks (AAP 0.4.2).

### reporting → `services/reporting`

| Method | Path | Required group | Procedure | Notes |
|---|---|---|---|---|
| POST | `reporting/exports` | `reporting.exporter` | `usp_export_job_transition` | `definitionId`, `format` (`xlsx`, `csv`, `pdf`), `asOf`. Returns the job queued; a `cfthread` runner moves it to running, then done or failed |
| GET | `reporting/exports` | `reporting.exporter` | — | Paged |
| GET | `reporting/exports/{id}` | `reporting.exporter` | — | — |
| GET | `reporting/exports/{id}/download` | `reporting.exporter` | — | Output file; 409 `not-ready` before done |

PDF text is drawn in cfdocument's built-in Times fonts with WinAnsiEncoding: characters outside Windows-1252, such as CJK, emoji, combining marks and C1 controls, are absent from it, and a no-break space or soft hyphen extracts as a space or hyphen. CSV and XLSX keep every character. The target reproduces the PDF rule with pdfkit's standard fonts.

### communications → `services/communications`

| Method | Path | Required group | Procedure | Notes |
|---|---|---|---|---|
| GET | `communications/templates` | `communications.sender` | — | Paged |
| POST | `communications/templates` | `communications.sender` | — | `name`, `subject`, `bodyText`, `bodyHtml` |
| GET | `communications/messages` | `communications.sender` | — | Paged |
| POST | `communications/messages` | `communications.sender` | — | `templateId` or literal content, `to`, `from`, `variables`. Sends with `cfmail` and records delivery once Mailpit shows the message |
| GET | `communications/messages/{id}` | `communications.sender` | — | Message with delivery-status history |

### esignature → `services/e-signature`

| Method | Path | Required group | Procedure | Notes |
|---|---|---|---|---|
| GET | `esignature/requests` | `esignature.signer` | — | Paged, without document bytes |
| POST | `esignature/requests` | `esignature.signer` | `usp_audit_append` | `documentName`, `documentBase64`, `signerUserId` |
| POST | `esignature/requests/{id}/sign` | `esignature.signer`, and the request's signer | `usp_audit_append` | `typedName`, holding a character other than a Unicode space, format or control character; 409 `already-signed` |
| GET | `esignature/requests/{id}/audit` | `esignature.auditor`, or `esignature.signer` held by the request's signer | — | Hash chain ordered by `seq` |
| GET | `esignature/requests/{id}/verify` | as audit | — | Recomputes the stored chain: `{valid, entries, brokenat}` |
| POST | `esignature/requests/{id}/verify` | as audit | — | `entries`: verifies a supplied copy (tamper detection) |

There is no `esignature/requests/{id}` read route; it answers 404.

## Authorisation

- The Masa session authenticates (`cfml/lib/auth.cfc`); no login answers 401 `authorization`.
- Masa groups authorise. A user holds a role when a member, at login, of the group of that name in the request site's private user pool:

| Masa group = target role | Module |
|---|---|
| `timesheets.employee`, `timesheets.primary-approver`, `timesheets.secondary-approver` | timesheets |
| `finance.preparer`, `finance.approver` | finance |
| `esignature.signer`, `esignature.auditor` | e-signature |
| `reporting.exporter` | reporting |
| `surveys.manager` | surveys |
| `communications.sender` | communications |

- The names and scope (`privateUserPool`) are exactly those of `services/identity/config/role-map.json`, which maps them to target roles when identity mints a token. Permission denials therefore compare one-to-one with the target (AAP 0.4.4).
- The people archive requires S2 or membership of the site's private-pool `Admin` group, the target's `s2` or `site-admin`.
- A logged-in user without a required group answers 403 `forbidden`.
- A write's CSRF token (see Routes) is validated after the role check and before the route's own 404, 400 and 409 answers. The survey task callbacks authorise by task token alone and take no CSRF token.

## Formats

- Responses use the Masa JSON envelope `{apiversion, method, params, data}`, built by `cfml/lib/envelope.cfc` with Masa's own `mura.jsonSerializer`. As in Masa, `params` is dropped when `suppressAPIParams` is on (the default), `data` is flattened when the data namespace is off, the content type is `application/json; charset=utf-8`, and `ETag` is `hash()` of the body.
- Errors replace `data` with `error: {code, message}`:

| Status | Error type | `error.code` | Raised for |
|---|---|---|---|
| 400 | `invalidParameters`, `invalidMethodCall`, `badRequest` | `invalid_request` | Bad or missing parameters, unknown site, repeated archive |
| 400 | `invalidTokens` | `invalid_request` | A logged-in write without a valid CSRF token; the message is `Invalid CSRF tokens` |
| 401 | `authorization` | `invalid_request` | No Masa login |
| 403 | `forbidden` | `invalid_request` | Wrong role, wrong signer, wrong task token |
| 404 | `notFound` | `invalid_request` | Unknown route, or a row outside the request site |
| 409 | `conflict` | `invalid_request` | Illegal state; the message names it, for example `blackout`, `already-signed`, `not-ready` |
| 500 | `server_error` | `server_error` | Unhandled exception, logged as a `log-record.v1` line without request values |

- Lists answer `items`, `startindex`, `endindex`, `itemsperpage`, `totalitems`, `totalpages` and `pageindex`, paged by `pageIndex` and `itemsPerPage` (default 50, at most 1000). `startindex` is `(pageIndex - 1) * itemsPerPage + 1`, `endindex` is `min(startindex + itemsPerPage - 1, totalitems)`, `totalpages` is `ceiling(totalitems / itemsPerPage)` and `pageindex` is the requested page; all six numbers are written as integers, for example `startindex` `2147483646001` for page 2147483647 at 1000 per page. These are the fixture's own semantics, which the target services copy. They depart from Masa's paged list (`core/mura/client/api/json/v1/jsonApiUtility.cfc:288-366`) in three ways:
  - There is no `entityname` and no `links`.
  - A page past the end keeps its `pageindex` and answers `items: []` with `endindex` equal to `totalitems`, so `startindex` exceeds `endindex` (page 8 at 150 per page over 1,000 rows gives 1051 and 1000). Masa resets the page to 1 when `(pageIndex - 1) * itemsPerPage` exceeds the total (`core/mura/iterator/queryIterator.cfc:219-226`).
  - An empty list answers `startindex` from the formula (1 on page 1), `endindex` 0, `totalpages` 0 and the requested `pageindex`. Masa answers 0 for `startindex`, `endindex` and `pageindex`.
- Ids are 35-character CF UUIDs. Amounts are four-decimal strings (`numeric(19,4)`). Timestamps are `yyyy-mm-ddTHH:nn:ss` (the e-signature audit chain keeps milliseconds) in the legacy server's time zone, and NULL is an empty string (AAP 0.5.5).
- Downloads (finance attachments, reporting exports) answer 200 with the stored bytes, `Content-Length`, no `ETag` and `Content-Disposition: attachment`. These are the fixture's own wire rules, which the target services copy:
  - `Content-Type` is the stored type exactly, with its parameters as stored and no charset added.
  - An ASCII name is sent as `attachment; filename="<name>"`, with `\` and `"` backslash-escaped.
  - A name with any non-ASCII character is sent as `attachment; filename="<fallback>"; filename*=UTF-8''<encoded>` (RFC 6266, RFC 5987), so the header stays ASCII. `<fallback>` is the name with each non-ASCII code point (a surrogate pair counts as one) replaced by `_`, then escaped as above. `<encoded>` is the name's UTF-8 bytes, each written as `%XX` in uppercase hex unless it is an attr-char: `A-Z`, `a-z`, `0-9` or one of ``!#$&+-.^_`|~``. For example, `résumé-€.txt` gives `filename="r_sum_-_.txt"; filename*=UTF-8''r%C3%A9sum%C3%A9-%E2%82%AC.txt`.
  - A control character in the name answers `server_error`.

## Seed

`seed/` generates the one dataset both sides start from (AAP 0.8.6): legacy through `cfml/seed.cfm`, the target only through backfill or `--direct`.

- `seed/seed.config.json` fixes `seed: 20260601` and `businessDate: 2026-06-30`, the default `${asOf}` of golden scenarios. A binding named `asOf` or a step's literal `asOf` overrides it; GS-TS-04, for example, also requests `2026-09-30` and `2026-03-31`.
- `reserved.rehearsal` reserves 10 `tenant-a` persons with open timesheet days and the usernames `rh-create-01` to `rh-create-10`. Only GS-PE-RH-01/02/03 may use them; `harness/src/golden/coverage.ts` fails on any other use.
- Each seeded site has the domain `<siteID>.localhost` and the alias `localhost`. Public requests to `<siteID>.localhost` bind to the site; its admin pages served on `localhost` call the JSON API on their own origin. Host `localhost` still binds to `default`, whose `orderNo` is 1.

| Site (tenant) | Pools | Size |
|---|---|---|
| `umbrella` | Pool site | 1,000 pooled members, 100 categories, pooled files |
| `tenant-a` (`Program_1`) | `publicUserPoolID`, `categoryPoolID`, `filePoolID`, `displayPoolID` = `umbrella`; own private user pool and content | 2,000 system users and 50 groups, 5,000 content nodes with versions, 20,000 timesheet days, 3,000 finance records, 500 survey responses, 200 export jobs |
| `tenant-b` (`Program_2`) | None | 200 users, 300 content nodes, 2,000 timesheet days, 300 finance records |
| `default` | As installed | The installed `admin` (S2) and `qa_editor` accounts; not generated |

Commands, from `seed/`:

| Command | Effect |
|---|---|
| `npm ci && npm run build && npm test` | Install (the `postinstall` builds `../../platform`), compile, run the tests with coverage |
| `npm run generate` | Writes `dataset.json`, its part files and `manifest.json` to `${OPT2_STATE_DIR}/seed/` (`--out` overrides), plus `credentials.json` there and in `${OPT2_STATE_DIR}/secrets/seed-credentials.json` |
| `npm run generate:direct` | `--direct`: sends the `dataset.json` that `npm run generate` wrote (same `--out` default) to the owning services' `/internal/v1/migration/apply` through `OPT2_SERVICE_URLS`, signed as the `migration` workload with the local key pair. The owning services must be running |

- The dataset is identical on every run; credentials are random per run, written with mode 0600 and never committed.
- `OPT2_SERVICE_URLS` is a JSON object of owning service name to base URL, with the keys `people`, `timesheets`, `finance`, `surveys`, `reporting`, `communications` and `e-signature`. With the ports in `harness/repro/ports.env`: `{"people":"http://127.0.0.1:8112","timesheets":"http://127.0.0.1:8118","finance":"http://127.0.0.1:8119","surveys":"http://127.0.0.1:8117","reporting":"http://127.0.0.1:8116","communications":"http://127.0.0.1:8115","e-signature":"http://127.0.0.1:8120"}`. Direct mode checks, before it reads the signing keys or sends anything, that every value is an http(s) URL and that every owner of a fixture table with rows has one; otherwise it exits 2.
- The local key pair is `${OPT2_STATE_DIR}/secrets/token-signing-private.pem` and `token-signing-public.pem`, generated by the secrets step of `harness/repro/up.sh`. `npm run generate` writes credentials only, never these keys; without them direct mode fails before its first batch.
- Both commands refuse an output directory inside the checkout; `generate` also refuses an `OPT2_STATE_DIR` inside it.
- Exit status: 0 when done; 1 when a run fails (in direct mode a missing or altered dataset, a missing key, or an owner's error answer or transport failure, which stops the run at that batch); 2 on a usage error, a missing or invalid `OPT2_SERVICE_URLS`, one without a URL for an owner of a table with rows, or a refused directory.
