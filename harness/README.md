# OPT-2 harness

Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

The harness produces the evidence for OPT-2 and runs the commands that reproduce it. It inventories the legacy Masa CMS 7.6.1 code at the pinned SHA, records the legacy TestBox baseline, captures golden outputs from legacy and replays them through the gateway, and runs the isolation, event, security and performance suites. It generates the evidence under `opt2/reports/` and provides the commands that boot, test and tear down the whole stack. It never edits a legacy file: Masa code, its tests and its manifests are read, never written.

## Reproduce

Run from the repository root. The commands take no arguments, are configured through the variables in [Environment](#environment), and print their usage with `--help`.

| Command | Does | Exit |
|---|---|---|
| `harness/repro/up.sh` | Boots legacy and the target stack with seed data | 0 stack up; 1 failure; 2 usage error |
| `harness/repro/test-all.sh` | Runs stages 0–9 against that stack and writes `opt2/reports/test-all.{json,md}`. The stack stays up | 0 every acceptance item met; 2 completed with acceptance items unmet, such as legacy fixtures unavailable, each listed in `opt2/reports/test-all.md`; 1 a stage failed, the run was interrupted, or it could not start |
| `harness/repro/down.sh` | Stops the stack and restores legacy | 0 stopped and restored, or nothing running; 1 failure; 2 usage error |
| `harness/repro/clean-checkout-proof.sh` | Proves `up.sh` and `test-all.sh` from a fresh clone | 0 proof passed; 1 proof failed; 2 usage error |

### Environment

A variable without a default is required by the commands under "Needed by"; the setup environment provides each. Secrets are named here, never given. `up.sh` stops before starting anything when a required one is missing, naming it.

| Variable | Needed by | Default | Purpose |
|---|---|---|---|
| `PORT` | `up.sh`; `down.sh` once a legacy server is captured | — | Legacy ColdFusion port. `test-all.sh` reads it from `up.json` |
| `OPT2_LEGACY_PORT` | `down.sh`, instead of `PORT` | `PORT` | Legacy port, read before `PORT`. `up.sh` starts legacy on `PORT`, so leave it unset or equal there |
| `MURA_DBHOST`, `MURA_DBPORT`, `MURA_DATABASE`, `MURA_DBUSERNAME` | `up.sh`; `down.sh` once a pristine baseline exists | `down.sh`: `MURA_DBPORT` 1433 | Legacy SQL Server database. `test-all.sh` reads them from `up.json`. strategies-content also gets `MURA_DATABASE`, which its SQL Server error messages name |
| `MURA_DBPASSWORD` (secret) | as `MURA_DBUSERNAME` | — | Password of `MURA_DBUSERNAME` |
| `MURA_DBTYPE` | `up.sh` | unset | Unset or `mssql`; any other value stops `up.sh` |
| `MURA_ADMIN_USERNAME` | `up.sh`, `test-all.sh` | `admin` | Legacy admin login for the seed and the golden runs |
| `MURA_ADMIN_PASSWORD` (secret) | `up.sh`, `test-all.sh` | — | Password of `MURA_ADMIN_USERNAME` |
| `MASA_TEST_EDITOR_PASSWORD` (secret) | `test-all.sh` | — | Password of `qa_editor` |
| `PG_HOST`, `PG_PORT`, `PG_DATABASE` | `up.sh`; `down.sh` (`PG_HOST`, `PG_PORT`) when `up.sh` started PostgreSQL | — | PostgreSQL server and the database of every OPT-2 schema. `test-all.sh` reads them from `up.json` |
| `PG_USER` | `up.sh`, `test-all.sh` | — | Admin login that bootstraps the schemas and roles and takes the checkpoints; target processes log in as `<schema>_app` |
| `PG_PASSWORD` (secret) | as `PG_USER` | — | Password of `PG_USER` |
| `CFCONFIG_ADMINPASSWORD` (secret) | `up.sh` | — | ColdFusion Administrator password, passed to the legacy start for CommandBox CFConfig |
| `GOOGLE_CLOUD_PROJECT` | `up.sh` | `opt2-local` | Pub/Sub emulator project. `test-all.sh` reads it from `up.json` |
| `OPT2_TZ` | `up.sh` | the legacy JVM's `-Duser.timezone`, else `TZ` or the host zone | Legacy time zone, exported as `TZ` to every process |
| `OPT2_LEGACY_SERVER_NAME` | `up.sh`, first run | the server whose webroot is this checkout, else the one on `PORT` | Original CommandBox server, captured once in `server-capture.json` |
| `OPT2_CF_SERVER_HOME`, `OPT2_CF_ENGINE`, `OPT2_CF_JVM_ARGS` | `up.sh`, `test-all.sh` | from `server-capture.json` | Server home, engine and JVM arguments of `opt2-legacy`; required when no server can be captured |
| `OPT2_MSSQL_BACKUP_DIR` | `up.sh`, first run | SQL Server's default backup directory | Pristine backup location when SQL Server cannot write `${OPT2_PRISTINE_DIR}` |
| `OPT2_MSSQL_TRUST_SERVER_CERT` | `up.sh`, `down.sh` | `true` | `false` stops `sqlcmd` and the migration service trusting SQL Server's certificate |
| `OPT2_SQLSERVR_CMD` | `up.sh` | `/opt/mssql/bin/sqlservr` | Starts SQL Server when it is not answering |
| `OPT2_PG_START_CMD` | `up.sh` | `pg_ctlcluster 16 main start` | Starts PostgreSQL when it is not answering |
| `OPT2_PG_STOP_CMD` | `down.sh` | `pg_ctlcluster 16 main stop` | Stops the PostgreSQL `up.sh` started |
| `OPT2_LEGACY_START_TIMEOUT_S` | `up.sh`, `test-all.sh`, `down.sh` | `900` | Seconds to wait for a legacy start |
| `MAILPIT_API_URL` | `up.sh`, `test-all.sh` | the port file's Mailpit API, `http://127.0.0.1:8025` | Mailpit API for the service-version probe and the golden and e2e mail checks |
| `OPT2_STATE_DIR`, `OPT2_PRISTINE_DIR` | all | see [State outside the checkout](#state-outside-the-checkout) | Run state and the pristine baseline |
| `OPT2_REPORTS_DIR` | `up.sh`, `test-all.sh` | `opt2/reports` | Reports directory; a relative value resolves against the checkout. Also passed to the gateway, the migration service and the `opt2-*` CLIs |
| `OPT2_PORTS_FILE` | all | `repro/ports.env` | Absolute path of the port file the scripts and `src/repro/ports.ts` read; see [Ports](#ports) |
| `OPT2_CF_SERVER_NAME` | all | `opt2-legacy` | CommandBox server name of this stack's legacy: a letter or digit, then letters, digits, `.`, `_` or `-` |
| `OPT2_LOCK_DIR` | all | `$HOME/.opt2` | Absolute directory of the run lock; another directory needs an `OPT2_CF_SERVER_NAME` other than `opt2-legacy`. See [One stack at a time](#one-stack-at-a-time) |

`clean-checkout-proof.sh` passes its environment to the other three except `OPT2_REPORTS_DIR`, so the clone writes its reports inside the clone. It reads `OPT2_CLONE_PARENT`, the clone's parent directory (default `$HOME/.opt2`). Other exported `MURA_*` settings reach Masa and, credentials aside, the target processes, except that `MURA_APPRELOADKEY` reaches only gateway, web, identity, people, programs-sites, strategies-content and migration, `MURA_S3ASSETS`, which can embed S3 credentials, reaches only web, and every process gets `MURA_PORT` and `MURA_PROXYPORT` set to the gateway port, as legacy's `server.json` does. For legacy this is a deliberate deviation from the pristine install, recorded in `opt2/reports/environment.md`: while the stack is up, a request sent to legacy directly on `${PORT}` gets absolute URLs that name the gateway port. Web alone gets `MURA_WEBROOT`, set to this checkout, which Masa always takes as its webroot (`expandPath('/muraWRM')`) whatever `MURA_WEBROOT` says. `up.sh` sets each target process's own variables (`PORT`, `OPT2_SERVICE_NAME`, `OPT2_SERVICE_URLS`, `PG_USER` and the rest) from the port file ([Ports](#ports)) and the generated secrets; see [platform configuration](../platform/README.md#configuration).

### `up.sh`

Boots on the existing ACF 2023, SQL Server 2022 and Mailpit installation; it never reinstalls an engine, the database or CommandBox.

The `MURA_*` and `TZ` entries of the captured legacy server's `server.json` `env` block override the inherited environment in `up.sh`, `test-all.sh` and `down.sh`, as CommandBox applies them to ColdFusion; the adopted names, never their values, are printed to stderr.

| Step | Name | Does |
|---|---|---|
| 1 | Pin and local versions | Before any lock, state write or installation, confirms the pin with git and node alone: the pinned commit exists, its subject matches and no file tracked at it is changed or gone. Then asserts Node 22.23.4 and npm 11.21.0; builds `platform` and installs the harness; runs the full pin check (`check:pin -- --confirm`); records local tool versions (`baseline:environment -- --phase local`) |
| 2 | Secrets | `repro:secrets` writes the local token-signing key pair, the storage, bridge, harness diagnostic and push keys and the database role passwords to `${OPT2_STATE_DIR}/secrets/` |
| 3 | Build | `npm ci && npm run build` in `gateway`, `web`, `migration`, `harness`, `legacy-fixtures/seed` and every `services/*`; installs Playwright Chromium; checks the port file (`repro/ports.env` or `OPT2_PORTS_FILE`) |
| 4 | Target tooling | Starts PostgreSQL 16, the Pub/Sub emulator and the OpenTelemetry Collector (`repro/otelcol-config.yaml`), each only if not running. A running collector is reused only when it is this checkout's, with the same `OPT2_STATE_DIR`; any other listener on its port stops `up.sh` |
| 5 | Quiesce and pristine baseline | Starts SQL Server if needed. If ColdFusion runs, captures its scheduled tasks and original `ping` once, then stops it. Takes the pristine baseline on the first run and restores from it on later runs. Then `load-fixtures.sh --check-only` writes `fixtures.json`. With fixtures unavailable, it builds the cut-over versions for that case in `${OPT2_STATE_DIR}/cutover` (`cutover:versions -- --fixtures unavailable`, then `cutover:validate`, with `v0001` byte-identical to the committed one) and exports `OPT2_CUTOVER_DIR` to every later process and CLI. Otherwise it removes that directory, and every process reads the committed `gateway/cutover` |
| 6 | Databases | `opt2-db bootstrap --target local` (schemas, roles, migrations); `opt2-migrate init-legacy` (schema `opt2_sync`); `opt2-migrate scheduler import` of the captured tasks |
| 7 | Topology | `topology -- --target local`: topics, push subscriptions, dead-letter topics and local task queues; then deletes the undeclared topology-named subscriptions and topics a reused emulator project still holds |
| 8 | Target processes | Starts every service, `web` and the migration service; runs `opt2-tasks reconcile` |
| 9 | Legacy start | `repro/lib/legacy-start.sh --fresh`, with every scheduled task paused at boot; it refuses to start while a deploy bundle exists or `MURA_PROJECTSITEID` is not `default`. An `opt2-legacy` CommandBox registration left by another checkout is released once ColdFusion is stopped, before the start (registry entry only; its server files are kept). Waits for `/` and the admin login form, then settles Masa's start-up (`repro/lib/legacy-settle.mjs`: one reload through `legacy-baseline/cfml/startup.cfm` that runs to completion), as every start through `legacy-start.sh` does; confirms Mailpit; starts the gateway |
| 10 | Service versions | `baseline:environment -- --phase services`: ColdFusion, SQL Server, PostgreSQL and Mailpit versions, time zone, `ping = false`, cluster settings and the start-up writer guards, which must be closed (`writersClosed`). A non-SQL Server legacy database is recorded as a baseline deviation, and the seed snapshot and backfill are skipped |
| 11 | Activate `v0001` | `repro:cutover -- activate v0001`; then repoints the native site-monitor task, if one existed, at the gateway and resumes it |
| 12 | Seed and backfill | Generates the fixed-seed dataset; `legacy-fixtures/load-fixtures.sh` (writes `fixtures.json`, and stops `up.sh` if availability differs from step 5); loads the seed into legacy, settling Masa's start-up after the sites part as step 9 does; regenerates `opt2/reports/assumptions.md` with live evidence (`inventory:assumptions -- --live`); takes the seed snapshot with its file manifest and backfills the target |
| 13 | `up.json` | Records pids, ports, snapshot, legacy server, fixture status and `cutoverDir` (the selected `OPT2_CUTOVER_DIR`, or `null` for the committed versions) in `${OPT2_STATE_DIR}/up.json` |

### `test-all.sh`

Needs the stack `up.sh` recorded. It exports the `cutoverDir` of `up.json` as `OPT2_CUTOVER_DIR`, so transitions, replay, coverage and rollback read the versions the gateway serves; package unit suites run without it, on the committed versions. A failing stage stops the later ones, except a `timing-variance` baseline and the skips when fixtures are unavailable. Stages 4–8 do not run when step 10 recorded a baseline deviation. Each stage is recorded in `${OPT2_STATE_DIR}/test-all/stage-<n>.json`, with its output in `stage-<n>.out`. An interrupted run (TERM, INT or HUP) stops its stage, records it failed with the later stages not-run, writes the report and exits 1. A run interrupted or failed between stage 4's `drain-and-suspend` and stage 5's `resume` leaves background work suspended, and `test-all.sh` then refuses to start on that stack until it is restarted (`down.sh`, then `up.sh`).

| Stage | Runs |
|---|---|
| 0 Pin and labels | `check:pin`, `check:synthetic` |
| 1 Legacy baseline | `baseline:run` (the official runner, which answers HTTP 500 with 0 specs, and the diagnostic runner); `baseline:compare` |
| 2 Platform on stub | `npm test` in `platform`, `gateway` and `services/stub`; `test:e2e -- isolation/platform-proof` |
| 3 Each service | `npm test` in identity, people, programs-sites and strategies-content, then `web`, `migration` and `harness` |
| 4 Migration | Reconcile `after-backfill`; each reconciling fault whose parameters accept `{"command":"backfill"}` (`applier-killed-mid-batch`, `service-restarted-mid-apply`), in that mode, before the first feed; `golden:workload` through the gateway; feed and reconcile `after-feed-1`; each other reconciling fault except `window-import-interrupted` (stage 6), with default parameters; each fault resumes and reconciles `after-fault-<fault>`; snapshot `Sk`; `feed --snapshot` to `Sk` (reconciles `after-feed-<k>`); `opt2-ops drain-and-suspend`; checkpoint `Ck` |
| 5 Capture | `golden:capture` against legacy directly (GS-ID-09 first, as stage 6 replays it before stage 7 replays the others), then the browser captures, then `golden:capture -- --rehearsal` (GS-ID-09 again as its rehearsal crossing, then the GS-PE-RH sets, as stage 8 replays them), then `test:e2e -- session/bridge-shared-values` against legacy directly; reset legacy and target to `Ck`, verify, `opt2-ops resume` |
| 6 Cut-over | `opt2-migrate transition --to v0002`, with GS-ID-09 crossing it; feed; reconcile `post-cutover`; `opt2-migrate fault window-import-interrupted` with default parameters (it needs a target-authoritative unit), which resumes, writes its legacy row back in a second window and reconciles `after-fault-window-import-interrupted` |
| 7 Equivalence and cross-cutting | `golden:replay`, the browser replay, `golden:compare`, `golden:coverage`; e2e suites for tenant isolation, seams, dead-letter replay, trace, roster protocol and the gateway authorisation matrix; `security:scan`; `infra/terraform/plan.sh`; `opt2-migrate window report`, then `test:e2e -- performance/performance`; `report:isolation`, `report:events` |
| 8 Rollback | People-roster rehearsal: `opt2-migrate rollback-set`, transition to `v0003` with GS-ID-09 crossing it (`--rehearsal`), `rollback rebaseline`, `golden:replay -- --rehearsal`, feed, reconcile `rollback-after`, `golden:compare`, `rollback report` |
| 9 Reports | `opt2-migrate window report`, `report:speed`, `check:reviewability`, `check:deck -- --render`, the migration service's `windows.json` and `transitions.json` |

### `down.sh` and `clean-checkout-proof.sh`

- `down.sh` stops every target process recorded in `up.json`. While the tooling still runs, it drops the snapshot databases `${MURA_DATABASE}_opt2_snap_<n>` (`opt2-migrate snapshot drop`, or directly where migration holds no record) with their `snap-<n>.bak` backups, then every OPT-2 PostgreSQL schema with its three roles (`opt2-db teardown --target local`). A PostgreSQL that does not answer fails that drop when `tooling.json` records one for this stack, and is only reported when it records none. It then stops the tooling `up.sh` started and ColdFusion, restores the legacy database and file store from the pristine baseline and re-imports the original scheduled tasks. It removes the `/muraWRM` mapping, or restores one that existed before. It then restarts the original legacy server with its own settings and `ping` (`legacy-start.sh --original`), removes this checkout's `opt2-legacy` CommandBox registration (the registry entry only; the server files are kept) and releases the lock. Another checkout's `opt2-legacy` registration is left in place. A failed step keeps the lock, and a failed schema drop also keeps PostgreSQL's `tooling.json` entry and does not stop an `up.sh`-started PostgreSQL, so rerunning `down.sh` retries them.
- `clean-checkout-proof.sh` runs `down.sh` in this checkout. It then makes a fresh `git clone --no-local` of the current commit into `${OPT2_CLONE_PARENT:-$HOME/.opt2}/opt2-clean-<timestamp>`, outside the working tree and never in a directory named `mura`. There it runs `up.sh` and `test-all.sh` with a fresh `OPT2_STATE_DIR` and the same `OPT2_PRISTINE_DIR`. It records the clone path (as `$OPT2_CLONE_PARENT/opt2-clean-<timestamp>`, with no host path), commit, both exit codes and the digest of the clone's `test-all.json` in `opt2/reports/reproducibility.md`, then runs the clone's `down.sh`. This checkout starts again only through an explicit `up.sh`.

### One stack at a time

Every command takes the lock `${OPT2_LOCK_DIR:-$HOME/.opt2}/run.lock`, which records the holder pid and checkout path, and refuses to run while another checkout holds it. The lock sits outside the state directory, so a clean clone sees it too.

- **One command at a time.** Each command also holds the per-command flock `run.lock.flock`, beside `run.lock`, while it runs. `up.sh` records its stack in `run.lock` only once its port check has passed, so a refused rerun leaves a live stack's record alone.
- **Waiting.** By default a command refuses at once. `OPT2_LOCK_WAIT=<seconds>` waits up to that long instead. `up.sh` and `clean-checkout-proof.sh` claim the stack, so they queue first come, first served in `run.queue/`, beside `run.lock`. The first waiter takes the flock only once no other checkout's stack holds `run.lock`, so it never blocks that stack's own `test-all.sh` or `down.sh`. A claimant with `OPT2_LOCK_WAIT=0` refuses while others are queued. `test-all.sh` and `down.sh`, and the checkout whose live stack holds `run.lock`, wait only for the running command.
- **Recovery.** `down.sh` marks `run.lock` as in teardown before it stops anything. If it fails or is interrupted, the mark stays, and every other checkout treats the stack as held until a rerun of that checkout's `down.sh` completes. Until then, that checkout's `up.sh`, `test-all.sh` and `clean-checkout-proof.sh` refuse too.
- **Nothing to tear down.** `down.sh` in a checkout with no `run.lock` of its own, no `up.json` and no `tooling.json` reports nothing running and exits 0 without taking the lock.
- **Commands started by another OPT-2 command.** These run under its flock. The parent exports the flock's token in `OPT2_LOCK_FLOCK_HELD`, and a child honours it only while that parent still holds the flock. `clean-checkout-proof.sh` holds it from its first `down.sh` to the clone's `down.sh`, so no other command gets in between. Any other value of `OPT2_LOCK_FLOCK_HELD` is ignored with a note.
- **A second stack on one host.** The defaults give one stack per host. A second stack moves all of these together: `OPT2_PORTS_FILE` (every port, the tooling ports included), `OPT2_CF_SERVER_NAME`, `OPT2_LOCK_DIR`, `PORT`, `OPT2_LEGACY_SERVER_NAME`, `MURA_DATABASE`, `PG_HOST`, `PG_PORT`, `PG_DATABASE`, `OPT2_STATE_DIR`, `OPT2_PRISTINE_DIR`, `GOOGLE_CLOUD_PROJECT` and `MAILPIT_API_URL`. `up.sh`, `test-all.sh`, `down.sh` and `clean-checkout-proof.sh` must all get the same values.

### State outside the checkout

| Directory | Default | Holds |
|---|---|---|
| `${OPT2_STATE_DIR}` | `$HOME/.opt2/state` | `secrets/`, `storage/`, `snapshots/`, `otel/traces.jsonl`, `seed/`, `up.json`, `fixtures.json`, and the run records under `baseline/`, `golden/`, `e2e/`, `security/`, `checkpoint/` and `test-all/` |
| `${OPT2_PRISTINE_DIR}` | `$HOME/.opt2/pristine` | `pristine.bak`, `filestore.tar`, `pristine.json`, `native-tasks.json` (with its CFConfig form `native-tasks.cfconfig.json`) and `server-capture.json`. Taken once with ColdFusion stopped and never overwritten. `pristine.taking.json` lists the artefacts of a capture that has not finished; the next `up.sh` removes them and takes the baseline again |

`test:e2e` refuses an `OPT2_STATE_DIR` inside the checkout.

### Ports

Fixed in `repro/ports.env`, unless `OPT2_PORTS_FILE` names another file in its format. That file sets every `OPT2_PORT_*` port; an `OPT2_TOOL_PORT_*` port it omits keeps the default below. `up.sh` stops if a target port equals `${PORT}` or is already in use.

| Process | Port |
|---|---|
| gateway | 8100 |
| web | 8101 |
| migration | 8102 |
| identity | 8111 |
| people | 8112 |
| programs-sites | 8113 |
| strategies-content | 8114 |
| stub | 8199 |
| legacy ColdFusion | `${PORT}` |

Shared tooling: Pub/Sub emulator 8085, Mailpit SMTP 1025 and API 8025. The stack's own OTLP/HTTP collector listens on 4319, beside the host collector on 4317/4318.

### Native processes

No Docker is used locally. `up.sh` starts every process natively; each package's `Dockerfile` is only its Cloud Run artefact. ColdFusion is started and restarted only through `repro/lib/legacy-start.sh`, with `MURA_PING=false`, `MURA_AUTODISCOVERPLUGINS=false`, `MURA_APPLYDBUPDATES=false`, `MURA_BROADCASTCLUSTERCOMMANDS=false`, `OPT2_BRIDGE_HMAC_KEY`, `OPT2_HARNESS_KEY` and `OPT2_GATEWAY_ORIGIN` on the start command, so Masa never registers its site-monitor task itself, its start-up neither discovers plugins nor applies DB updates, and it queues no cluster reload commands (the start-up guard on content units). Its `java.io.tmpdir`, Masa's `getTempDirectory()`, is `${OPT2_STATE_DIR}/legacy-tmp`, emptied before every start, never the host's shared `/tmp`. Its `-Dcom.sun.media.imageio.disableCodecLib=true` leaves ImageIO one PNG reader and writer, the JDK's: the engine's JAI Image I/O codecLib PNG plugins are unordered against them, so otherwise each start may encode image renditions with another codec, and a capture and a replay on either side of a restart write different bytes for the same pixels.

## Package

The package scripts run in `harness/`. From the repository root:

```sh
cd harness
npm ci              # installs, then builds ../platform through postinstall
npm run build       # generates the gateway and migration client types, then type-checks (tsc, no emit)
npm run typecheck   # type-checks src/, test/, e2e/ and both vitest configs without generating (tsc, no emit)
npm run lint        # eslint with typescript-eslint recommended (test/eslint.config.mjs)
npm test            # test/** only, with coverage (>= 90% statements); needs no legacy oracle or running stack
npm run test:contract   # the check-pin, check-synthetic, catalogue-response-paths and route-key-parity suites of test/
npm run test:security   # test/security and the repro:secrets suite
npm run test:e2e    # e2e/** only, serially; needs the stack up.sh started; called by test-all.sh
```

`npm run test:e2e -- <suite>` runs one suite, for example `isolation/platform-proof`. Every other script runs one CLI through `tsx`. Pass its flags after `--`, as in `npm run check:pin -- --confirm`.

| Script | Entry | Writes |
|---|---|---|
| `postinstall` | `npm ci` and `npm run build` in `../platform` | `platform/dist/` |
| `generate` (run by `prebuild`) | `openapi-typescript` over `gateway/contracts/openapi.yaml` and `migration/contracts/openapi.yaml` | `src/generated/clients/{gateway,migration}.ts` |
| `build` | `tsc -p tsconfig.json` | — |
| `typecheck` | `tsc -p tsconfig.json` | — |
| `lint` | `eslint --config test/eslint.config.mjs .` | — |
| `test` | `vitest.config.ts` | `coverage/` |
| `test:contract` | `vitest.config.ts`: `test/reporting/check-pin*`, `test/reporting/check-synthetic*`, `test/golden/catalogue-response-paths*`, `test/route-key-parity*` | — |
| `test:security` | `vitest.config.ts`: `test/security/`, `test/repro/secrets*` | — |
| `test:e2e` | `vitest.e2e.config.ts` | `${OPT2_STATE_DIR}/e2e/results.json`; suite reports such as `opt2/reports/platform-proof.json` and `opt2/reports/observability.json` |
| `inventory` | `src/inventory/generate.ts` (`--live` captures `live-catalog.json`; other runs replay it) | `opt2/inventory/legacy-inventory.{json,md}`; with `--live`, `opt2/inventory/live-catalog.json` |
| `inventory:cloc` | `src/inventory/cloc.ts` | `opt2/inventory/cloc.{json,md}` |
| `inventory:assumptions` | `src/inventory/assumptions.ts` | `opt2/reports/assumptions.md` |
| `baseline:environment` | `src/baseline/environment.ts` (`--phase local\|services`) | `opt2/reports/environment.md` |
| `baseline:run` | `src/baseline/run.ts` | Raw runner responses under `${OPT2_STATE_DIR}/baseline/` |
| `baseline:compare` | `src/baseline/compare.ts` | `opt2/reports/baseline.{json,md}`, `/tmp/masa-baseline.json` |
| `golden:capture` | `src/golden/capture.ts` | `golden/sets/<scenario-id>.json`; with `--rehearsal`, a rehearsal crossing's under `golden/sets/rehearsal/` and the GS-PE-RH sets |
| `golden:replay` | `src/golden/replay.ts` | `${OPT2_STATE_DIR}/golden/replay/<scenario-id>.json`; with `--rehearsal`, a non-rehearsal scenario's crossing of `v0003` under `golden/replay/rehearsal/` |
| `golden:compare` | `src/golden/compare.ts` | `opt2/reports/parity.{json,md}` (rehearsal crossings in `rehearsalCrossings`, outside `summary`), `opt2/exceptions-list.md` |
| `golden:coverage` | `src/golden/coverage.ts` | `${OPT2_STATE_DIR}/golden/coverage.json` |
| `golden:workload` | `src/golden/workload.ts` | `${OPT2_STATE_DIR}/golden/workload.json` |
| `check:pin` | `src/reporting/check-pin.ts` | — (confirms the pin with `--confirm`; checks the SHA in every deliverable) |
| `check:synthetic` | `src/reporting/check-synthetic.ts` | — (checks the SYNTHETIC labels) |
| `check:reviewability` | `src/reporting/check-reviewability.ts` | `opt2/reports/reviewability.{json,md}` |
| `check:deck` | `src/reporting/check-deck.ts` | — (verifies `opt2/executive-summary/index.html`) |
| `report:speed` | `src/reporting/speed.ts` | `opt2/reports/speed.{json,md}` |
| `report:test-all` | `src/reporting/test-all.ts` | `${OPT2_STATE_DIR}/test-all/stage-<n>.json` (`record`); `opt2/reports/test-all.{json,md}`; — (`check` validates `fixtures.json` and `OPT2_REPORTS_DIR` before stage 0) |
| `report:isolation` | `src/isolation/report.ts` | `opt2/reports/isolation.json` |
| `report:events` | `src/events/report.ts` | `opt2/reports/events.json` |
| `security:scan` | `src/security/scan.ts` | `${OPT2_STATE_DIR}/security/{osv,gitleaks,summary}.json` |
| `performance` | `src/performance/run.ts` | `opt2/reports/performance.{json,md}` |
| `topology` | `src/repro/pubsub-topology.ts` | `--target local`: the emulator topology, retiring undeclared topology-named subscriptions and topics; `--target cloud`: `infra/terraform/envs/plan/topology.auto.tfvars.json` (`--check` compares instead) |
| `repro:secrets` | `src/repro/secrets.ts` | `${OPT2_STATE_DIR}/secrets/` |
| `repro:cutover` | `src/repro/cutover.ts` (`activate <vNNNN>`, `status`) | — (calls the gateway) |
| `repro:up-state` | `src/repro/up-state.ts` (`read`, `write`) | `${OPT2_STATE_DIR}/up.json` |

`npm run check:deck` verifies the executive deck against the "Executive Presentation" rule. With `-- --render`, it also renders the deck in Chromium.

## Layout

- `legacy-baseline/`: the diagnostic TestBox runner, served from the legacy web root. Its `cfml/Application.cfc` extends `muraWRM.Application`, so `cfml/run.cfm` runs inside Masa's application. It serves only `run.cfm` and `startup.cfm`, and only to a loopback caller whose `X-Opt2-Harness-Key` header equals ColdFusion's `OPT2_HARNESS_KEY` (`${OPT2_STATE_DIR}/secrets/harness-diagnostic-key`); any other request gets an empty 404 or 403. The runner names the 22 core bundles explicitly and leaves out `bundleValidatorSecurity`, which does not compile on ACF. `run.cfm?info=1` and `?info=entities` report the engine and the registered entities. `run.cfm?info=1` also reports the database, `server.java` and OS values the admin Version menu prints; `src/baseline/environment.ts` records them as `settings.versionMenu` in `${OPT2_STATE_DIR}/baseline/environment.json`. `startup.cfm?op=reload`, the only request that reloads Masa, re-initialises it inside Masa's start-up lock and stamps a start-up that completed; `?op=status` reports whether the last start-up is that stamped one. `expected-baseline.json` holds the expected totals: 22 bundles, 683 specs, 662 passed, 21 failed, 0 errored.
- `inventory/`: reviewed overrides for what the inventory extractor cannot classify (`role-overrides.yaml`, `writer-overrides.yaml`), and the included admin views reviewed as partials rather than actions (`view-partials.yaml`).
- `golden/`: the scenario catalogue (`catalogue.yaml`), the normaliser rules (`normalise.yaml`) and the committed golden sets (`sets/`, see [`golden/sets/README.md`](golden/sets/README.md)).
- `security/`: the gitleaks configuration and its baseline, which holds pre-existing legacy findings only.
- `src/`: the CLIs in the script table and their libraries (`baseline`, `events`, `golden` with the one normaliser in `golden/normalise/`, `inventory`, `isolation`, `lib`, `performance`, `reporting`, `repro`, `security`). `src/generated/` is build output.
- `test/`: unit suites over `src/`, with recorded fixtures; no oracle or running stack.
- `e2e/`: oracle and full-stack suites (`events`, `isolation`, `performance`, `security`, `session`, `ui`), run only through `test:e2e`.
- `repro/`: the four commands, `ports.env`, `server.json.template`, `otelcol-config.yaml` and `lib/` (lock, process control, pristine baseline, checkpoint `Ck`, `legacy-start.sh`).

## Boundaries

| Store | Harness access |
|---|---|
| Legacy Masa and the gateway | HTTP |
| Mailpit | Its HTTP API |
| Traces | The OTel file export `${OPT2_STATE_DIR}/otel/traces.jsonl` |
| SQL Server | Read-only queries: baseline and fixture checks, the stored-procedure check, rows a scenario touches |
| PostgreSQL | Read-only catalog queries through `${PG_USER}` (`pg_roles`, `pg_auth_members`, `pg_class.relforcerowsecurity`, policies) |

- Harness code never writes a service schema or a Masa table. Legacy and target data change only through HTTP requests to legacy and the gateway.
- The resets of the test sequence are the only exception. They are the pristine restore, the legacy `RESTORE` and the `pg_restore` of checkpoint `Ck`, and they are run by `repro/lib/pristine.sh`, `repro/lib/checkpoint.sh` and `opt2-migrate snapshot restore`.
- Legacy files are references only. The official runner `core/tests/runner.cfm` and every spec under `core/tests/specs/` stay untouched. `legacy-baseline/` reproduces the runner's logic from outside `core/`.
