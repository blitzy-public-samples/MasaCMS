# OPT-2 harness

Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

The harness produces the evidence for OPT-2 and runs the commands that reproduce it. It inventories the legacy Masa CMS 7.6.1 code at the pinned SHA, records the legacy TestBox baseline, captures golden outputs from legacy and replays them through the gateway, and runs the isolation, event, security and performance suites. It generates the evidence under `opt2/reports/` and provides the commands that boot, test and tear down the whole stack. It never edits a legacy file: Masa code, its tests and its manifests are read, never written.

## Reproduce

Run from the repository root. The commands take no arguments, are configured through the environment, and print their usage with `--help`.

| Command | Does | Exit |
|---|---|---|
| `harness/repro/up.sh` | Boots legacy and the target stack with seed data | 0 stack up; 1 failure; 2 usage error |
| `harness/repro/test-all.sh` | Runs stages 0–9 against that stack and writes `opt2/reports/test-all.{json,md}`. The stack stays up | 0 every acceptance item met; 2 completed with acceptance items unmet, such as legacy fixtures unavailable, each listed in `opt2/reports/test-all.md`; 1 a stage failed or the run could not start |
| `harness/repro/down.sh` | Stops the stack and restores legacy | 0 stopped and restored, or nothing running; 1 failure; 2 usage error |
| `harness/repro/clean-checkout-proof.sh` | Proves `up.sh` and `test-all.sh` from a fresh clone | 0 proof passed; 1 proof failed; 2 usage error |

### `up.sh`

Boots on the existing ACF 2023, SQL Server 2022 and Mailpit installation; it never reinstalls an engine, the database or CommandBox.

| Step | Name | Does |
|---|---|---|
| 1 | Pin and local versions | Asserts Node 22.23.4 and npm 11.21.0; builds `platform` and installs the harness; confirms the pin (`check:pin -- --confirm`); records local tool versions (`baseline:environment -- --phase local`) |
| 2 | Secrets | `repro:secrets` writes the local token-signing key pair, the storage, bridge and push keys and the database role passwords to `${OPT2_STATE_DIR}/secrets/` |
| 3 | Build | `npm ci && npm run build` in `gateway`, `web`, `migration`, `harness`, `legacy-fixtures/seed` and every `services/*`; installs Playwright Chromium; checks `repro/ports.env` |
| 4 | Target tooling | Starts PostgreSQL 16, the Pub/Sub emulator and the OpenTelemetry Collector (`repro/otelcol-config.yaml`), each only if not running |
| 5 | Quiesce and pristine baseline | Starts SQL Server if needed. If ColdFusion runs, captures its scheduled tasks and original `ping` once, then stops it. Takes the pristine baseline on the first run and restores from it on later runs |
| 6 | Databases | `opt2-db bootstrap --target local` (schemas, roles, migrations); `opt2-migrate init-legacy` (schema `opt2_sync`); `opt2-migrate scheduler import` of the captured tasks |
| 7 | Topology | `topology -- --target local`: topics, push subscriptions, dead-letter topics and local task queues |
| 8 | Target processes | Starts every service, `web` and the migration service; runs `opt2-tasks reconcile` |
| 9 | Legacy start | `repro/lib/legacy-start.sh --fresh`, with every scheduled task paused at boot; waits for `/` and the admin login form; confirms Mailpit; starts the gateway |
| 10 | Service versions | `baseline:environment -- --phase services`: ColdFusion, SQL Server, PostgreSQL and Mailpit versions, time zone, `ping = false`, cluster settings. A non-SQL Server legacy database is recorded as a baseline deviation, and the seed snapshot and backfill are skipped |
| 11 | Activate `v0001` | `repro:cutover -- activate v0001`; then repoints the native site-monitor task, if one existed, at the gateway and resumes it |
| 12 | Seed and backfill | Generates the fixed-seed dataset; `legacy-fixtures/load-fixtures.sh` (writes `fixtures.json`); loads the seed into legacy; takes the seed snapshot with its file manifest and backfills the target |
| 13 | `up.json` | Records pids, ports, snapshot, legacy server and fixture status in `${OPT2_STATE_DIR}/up.json` |

### `test-all.sh`

Needs the stack `up.sh` recorded. A failing stage stops the later ones, except a `timing-variance` baseline and the skips when fixtures are unavailable. Stages 4–8 do not run when step 10 recorded a baseline deviation. Each stage is recorded in `${OPT2_STATE_DIR}/test-all/stage-<n>.json`, with its output in `stage-<n>.out`.

| Stage | Runs |
|---|---|
| 0 Pin and labels | `check:pin`, `check:synthetic` |
| 1 Legacy baseline | `baseline:run` (the official runner, which answers HTTP 500 with 0 specs, and the diagnostic runner); `baseline:compare` |
| 2 Platform on stub | `npm test` in `platform`, `gateway` and `services/stub`; `test:e2e -- isolation/platform-proof` |
| 3 Each service | `npm test` in identity, people, programs-sites, strategies-content, communications, reporting, surveys, timesheets, finance and e-signature, then `web`, `migration` and `harness` |
| 4 Migration | Reconcile `after-backfill`; `golden:workload` through the gateway; feed and reconcile `after-feed-1`; each reconciling fault; snapshot `Sk`; `opt2-ops drain-and-suspend`; checkpoint `Ck` |
| 5 Capture | `golden:capture` against legacy directly, plus the browser captures; reset legacy and target to `Ck`, verify, `opt2-ops resume` |
| 6 Cut-over | `opt2-migrate transition --to v0002`, with GS-ID-09 crossing it; reconcile `post-cutover` |
| 7 Equivalence and cross-cutting | `golden:replay`, the browser replay, `golden:compare`, `golden:coverage`; e2e suites for tenant isolation, seams, dead-letter replay, trace, roster protocol and the gateway authorisation matrix; `security:scan`; `infra/terraform/plan.sh`; `test:e2e -- performance/performance`; `report:isolation`, `report:events` |
| 8 Rollback | People-roster rehearsal: `opt2-migrate rollback-set`, transition to `v0003`, `rollback rebaseline`, `golden:replay -- --rehearsal`, feed, reconcile `rollback-after`, `golden:compare`, `rollback report` |
| 9 Reports | `report:speed`, `check:reviewability`, `check:deck -- --render`, the migration service's `windows.json` and `transitions.json` |

### `down.sh` and `clean-checkout-proof.sh`

- `down.sh` stops every target process recorded in `up.json`, the tooling `up.sh` started and ColdFusion. It restores the legacy database and file store from the pristine baseline and re-imports the original scheduled tasks. It removes the `/muraWRM` mapping, or restores one that existed before. It then restarts the original legacy server with its own settings and `ping` (`legacy-start.sh --original`) and releases the lock.
- `clean-checkout-proof.sh` runs `down.sh` in this checkout. It then makes a fresh `git clone --no-local` of the current commit into `${OPT2_CLONE_PARENT:-$HOME/.opt2}/opt2-clean-<timestamp>`, outside the working tree and never in a directory named `mura`. There it runs `up.sh` and `test-all.sh` with a fresh `OPT2_STATE_DIR` and the same `OPT2_PRISTINE_DIR`. It records the clone path, commit, both exit codes and the digest of the clone's `test-all.json` in `opt2/reports/reproducibility.md`, then runs the clone's `down.sh`. This checkout starts again only through an explicit `up.sh`.

### One stack at a time

Every command takes the lock `$HOME/.opt2/run.lock`, which records the holder pid and checkout path, and refuses to run while another checkout holds it. The lock sits under `$HOME`, not the state directory, so a clean clone sees it too.

### State outside the checkout

| Directory | Default | Holds |
|---|---|---|
| `${OPT2_STATE_DIR}` | `$HOME/.opt2/state` | `secrets/`, `storage/`, `snapshots/`, `otel/traces.jsonl`, `seed/`, `up.json`, `fixtures.json`, and the run records under `baseline/`, `golden/`, `e2e/`, `security/`, `checkpoint/` and `test-all/` |
| `${OPT2_PRISTINE_DIR}` | `$HOME/.opt2/pristine` | `pristine.bak`, `filestore.tar`, `pristine.json`, `native-tasks.json` (with its CFConfig form `native-tasks.cfconfig.json`) and `server-capture.json`. Taken once with ColdFusion stopped and never overwritten |

`test:e2e` refuses an `OPT2_STATE_DIR` inside the checkout.

### Ports

Fixed in `repro/ports.env`. `up.sh` stops if a target port equals `${PORT}` or is already in use.

| Process | Port |
|---|---|
| gateway | 8100 |
| web | 8101 |
| migration | 8102 |
| identity | 8111 |
| people | 8112 |
| programs-sites | 8113 |
| strategies-content | 8114 |
| communications | 8115 |
| reporting | 8116 |
| surveys | 8117 |
| timesheets | 8118 |
| finance | 8119 |
| e-signature | 8120 |
| stub | 8199 |
| legacy ColdFusion | `${PORT}` |

Shared tooling: Pub/Sub emulator 8085, OTLP/HTTP 4318, Mailpit SMTP 1025 and API 8025.

### Native processes

No Docker is used locally. `up.sh` starts every process natively; each package's `Dockerfile` is only its Cloud Run artefact. ColdFusion is started and restarted only through `repro/lib/legacy-start.sh`, with `MURA_PING=false`, `OPT2_BRIDGE_HMAC_KEY` and `OPT2_GATEWAY_ORIGIN` on the start command, so Masa never registers its site-monitor task itself.

## Package

```sh
npm ci              # installs, then builds ../platform through postinstall
npm run build       # generates the gateway and migration client types, then type-checks (tsc, no emit)
npm test            # test/** only, with coverage (>= 90% statements); needs no legacy oracle or running stack
npm run test:e2e    # e2e/** only, serially; needs the stack up.sh started; called by test-all.sh
```

`npm run test:e2e -- <suite>` runs one suite, for example `isolation/platform-proof`. Every other script runs one CLI through `tsx`. Pass its flags after `--`, as in `npm run check:pin -- --confirm`.

| Script | Entry | Writes |
|---|---|---|
| `postinstall` | `npm ci` and `npm run build` in `../platform` | `platform/dist/` |
| `generate` (run by `prebuild`) | `openapi-typescript` over `gateway/contracts/openapi.yaml` and `migration/contracts/openapi.yaml` | `src/generated/clients/{gateway,migration}.ts` |
| `build` | `tsc -p tsconfig.json` | — |
| `test` | `vitest.config.ts` | `coverage/` |
| `test:e2e` | `vitest.e2e.config.ts` | `${OPT2_STATE_DIR}/e2e/results.json`; suite reports such as `opt2/reports/platform-proof.json` and `opt2/reports/observability.json` |
| `inventory` | `src/inventory/generate.ts` | `opt2/inventory/legacy-inventory.{json,md}` |
| `inventory:cloc` | `src/inventory/cloc.ts` | `opt2/inventory/cloc.{json,md}` |
| `inventory:assumptions` | `src/inventory/assumptions.ts` | `opt2/reports/assumptions.md` |
| `baseline:environment` | `src/baseline/environment.ts` (`--phase local\|services`) | `opt2/reports/environment.md` |
| `baseline:run` | `src/baseline/run.ts` | Raw runner responses under `${OPT2_STATE_DIR}/baseline/` |
| `baseline:compare` | `src/baseline/compare.ts` | `opt2/reports/baseline.{json,md}`, `/tmp/masa-baseline.json` |
| `golden:capture` | `src/golden/capture.ts` | `golden/sets/<scenario-id>.json` |
| `golden:replay` | `src/golden/replay.ts` | `${OPT2_STATE_DIR}/golden/replay/<scenario-id>.json` |
| `golden:compare` | `src/golden/compare.ts` | `opt2/reports/parity.{json,md}`, `opt2/exceptions-list.md` |
| `golden:coverage` | `src/golden/coverage.ts` | `${OPT2_STATE_DIR}/golden/coverage.json` |
| `golden:workload` | `src/golden/workload.ts` | `${OPT2_STATE_DIR}/golden/workload.json` |
| `check:pin` | `src/reporting/check-pin.ts` | — (confirms the pin with `--confirm`; checks the SHA in every deliverable) |
| `check:synthetic` | `src/reporting/check-synthetic.ts` | — (checks the SYNTHETIC labels) |
| `check:reviewability` | `src/reporting/check-reviewability.ts` | `opt2/reports/reviewability.{json,md}` |
| `check:deck` | `src/reporting/check-deck.ts` | — (verifies `opt2/executive-summary/index.html`) |
| `report:speed` | `src/reporting/speed.ts` | `opt2/reports/speed.{json,md}` |
| `report:test-all` | `src/reporting/test-all.ts` | `${OPT2_STATE_DIR}/test-all/stage-<n>.json` (`record`); `opt2/reports/test-all.{json,md}` |
| `report:isolation` | `src/isolation/report.ts` | `opt2/reports/isolation.json` |
| `report:events` | `src/events/report.ts` | `opt2/reports/events.json` |
| `security:scan` | `src/security/scan.ts` | `${OPT2_STATE_DIR}/security/{osv,gitleaks,summary}.json` |
| `performance` | `src/performance/run.ts` | `opt2/reports/performance.{json,md}` |
| `topology` | `src/repro/pubsub-topology.ts` | `--target local`: the emulator topology; `--target cloud`: `infra/terraform/envs/plan/topology.auto.tfvars.json` (`--check` compares instead) |
| `repro:secrets` | `src/repro/secrets.ts` | `${OPT2_STATE_DIR}/secrets/` |
| `repro:cutover` | `src/repro/cutover.ts` (`activate <vNNNN>`, `status`) | — (calls the gateway) |
| `repro:up-state` | `src/repro/up-state.ts` (`read`, `write`) | `${OPT2_STATE_DIR}/up.json` |

`npm run check:deck` verifies the executive deck against the "Executive Presentation" rule. With `-- --render`, it also renders the deck in Chromium.

## Layout

- `legacy-baseline/`: the diagnostic TestBox runner, served from the legacy web root. Its `cfml/Application.cfc` extends `muraWRM.Application`, so `cfml/run.cfm` runs inside Masa's application. The runner names the 22 core bundles explicitly and leaves out `bundleValidatorSecurity`, which does not compile on ACF. `run.cfm?info=1` and `?info=entities` report the engine and the registered entities. `expected-baseline.json` holds the expected totals: 22 bundles, 683 specs, 662 passed, 21 failed, 0 errored.
- `inventory/`: reviewed overrides for what the inventory extractor cannot classify (`role-overrides.yaml`, `writer-overrides.yaml`).
- `golden/`: the scenario catalogue (`catalogue.yaml`), the normaliser rules (`normalise.yaml`) and the committed golden sets (`sets/`, see [`golden/sets/README.md`](golden/sets/README.md)).
- `security/`: the gitleaks configuration and its baseline, which holds pre-existing legacy findings only.
- `src/`: the CLIs in the script table and their libraries (`baseline`, `events`, `golden` with the one normaliser in `golden/normalise/`, `inventory`, `isolation`, `lib`, `performance`, `reporting`, `repro`, `security`). `src/generated/` is build output.
- `test/`: unit suites over `src/`, with recorded fixtures; no oracle or running stack.
- `e2e/`: oracle and full-stack suites (`events`, `isolation`, `performance`, `security`, `ui`), run only through `test:e2e`.
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
