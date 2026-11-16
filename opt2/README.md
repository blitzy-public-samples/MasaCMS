# OPT-2 deliverables

Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

OPT-2 moves Masa CMS 7.6.1 to ten TypeScript services on Cloud Run as a strangler fig: a gateway sends each route to legacy or to its owning service by the active version of a versioned cut-over table. Legacy behaviour stays unchanged on every moved route, and no legacy file is edited; every OPT-2 artefact is a new file.

The pin is recorded once, in [`source-pin.json`](source-pin.json); every deliverable carries it.

## Reproduce

Prerequisites: Node 22.23.4, npm 11.21.0, PostgreSQL 16, the Pub/Sub emulator, otelcol-contrib, and the existing ACF 2023 / SQL Server 2022 / Mailpit environment, with the variables in [harness environment](../harness/README.md#environment).

Run from the repository root:

- [`harness/repro/up.sh`](../harness/repro/up.sh) boots legacy and target with seed data, on the installed engines and without Docker; it exits 0 when the stack is up.
- [`harness/repro/test-all.sh`](../harness/repro/test-all.sh) runs stages 0–9 in the order of proof and writes [`reports/test-all.json`](reports/test-all.json) and [`reports/test-all.md`](reports/test-all.md); it exits 0, or 2 when the legacy fixtures are unavailable and acceptance items are unmet.
- [`harness/repro/down.sh`](../harness/repro/down.sh) stops the stack and restores the pristine legacy baseline.
- [`harness/repro/clean-checkout-proof.sh`](../harness/repro/clean-checkout-proof.sh) proves both commands from a fresh clone and writes [`reports/reproducibility.md`](reports/reproducibility.md).

## Deliverable index

Paths are relative to `opt2/`.

| Deliverable | Path | Produced by |
|---|---|---|
| Source pin | [`source-pin.json`](source-pin.json) | Recorded once; verified by `harness/src/reporting/check-pin.ts --confirm` |
| Legacy inventory (the first deliverable) | [`inventory/legacy-inventory.json`](inventory/legacy-inventory.json), [`inventory/legacy-inventory.md`](inventory/legacy-inventory.md) | `harness/src/inventory/` |
| Size report | [`inventory/cloc.json`](inventory/cloc.json), [`inventory/cloc.md`](inventory/cloc.md) | `harness/src/inventory/cloc.ts` |
| Owner of every legacy table, with its target tables and units | [`table-ownership.json`](table-ownership.json), [`table-ownership.md`](table-ownership.md) | Reviewed source; read by `harness/src/inventory/` and `gateway/src/cutover/` |
| Items awaiting the user, all withheld | [`decision-list.json`](decision-list.json), [`decision-list.md`](decision-list.md) | Reviewed source; read by `harness/src/inventory/` and `gateway/src/cutover/` |
| Halts and proposed differences | [`exceptions-list.json`](exceptions-list.json), [`exceptions-list.md`](exceptions-list.md) | JSON: reviewed source; `harness/src/golden/capture.ts` appends gap entries and `harness/src/golden/replay.ts` halted cases. Markdown: rendered by `harness/src/golden/compare.ts` |
| Generated reports | [`reports/`](reports/) | See [Reports](#reports) |
| Per-service activity bounds of the generating run | [`speed/blitzy-activity.json`](speed/blitzy-activity.json) | The generating run |
| Leadership deck (rule "Executive Presentation") | [`executive-summary/index.html`](executive-summary/index.html) | Authored from `reports/`; checked by `harness/src/reporting/check-deck.ts` |

### Reports

| Report | Produced by |
|---|---|
| [`reports/environment.md`](reports/environment.md) | `harness/src/baseline/environment.ts` |
| [`reports/assumptions.md`](reports/assumptions.md) | `harness/src/inventory/assumptions.ts` |
| [`reports/baseline.json`](reports/baseline.json), [`reports/baseline.md`](reports/baseline.md) | `harness/src/baseline/compare.ts` |
| [`reports/parity.json`](reports/parity.json), [`reports/parity.md`](reports/parity.md) | `harness/src/golden/compare.ts` |
| [`reports/isolation.json`](reports/isolation.json) | `harness/src/isolation/report.ts` |
| [`reports/events.json`](reports/events.json) | `harness/src/events/report.ts` |
| [`reports/observability.json`](reports/observability.json) | `harness/e2e/events/trace.e2e.test.ts` |
| [`reports/platform-proof.json`](reports/platform-proof.json) | `harness/e2e/isolation/platform-proof.e2e.test.ts` |
| [`reports/test-all.json`](reports/test-all.json), [`reports/test-all.md`](reports/test-all.md) | `harness/repro/test-all.sh`, through `harness/src/reporting/test-all.ts` |
| [`reports/reproducibility.md`](reports/reproducibility.md) | `harness/repro/clean-checkout-proof.sh` |
| [`reports/speed.json`](reports/speed.json), [`reports/speed.md`](reports/speed.md) | `harness/src/reporting/speed.ts` |
| [`reports/reviewability.json`](reports/reviewability.json), [`reports/reviewability.md`](reports/reviewability.md) | `harness/src/reporting/check-reviewability.ts` |
| [`reports/windows.json`](reports/windows.json) | `migration/src/windows/` |
| [`reports/transitions.json`](reports/transitions.json) | `migration/src/transition/` |
| [`reports/migration-order.json`](reports/migration-order.json) | `migration/src/order/dependency-order.ts` |
| [`reports/terraform-plan.json`](reports/terraform-plan.json) | `infra/terraform/plan.sh` |
| [`reports/pre-existing-defects.md`](reports/pre-existing-defects.md) | Authored, with source locations at the pin; linked from `exceptions-list.md` by `harness/src/golden/compare.ts` |
| [`reports/rollback-rehearsal.md`](reports/rollback-rehearsal.md) | `opt2-migrate` (`migration/src/rollback/`), following [`migration/runbooks/people-roster-rollback.md`](../migration/runbooks/people-roster-rollback.md) |
| [`reports/reconciliation/`](reports/reconciliation/) | `opt2-migrate reconcile` (`migration/src/reconcile/`) |
| [`reports/state-machines/`](reports/state-machines/) | `services/finance/scripts/export-transitions.ts`, `services/timesheets/scripts/export-transitions.ts` |

## Services, schemas and topics

Each service owns one PostgreSQL schema and documents itself in its `README.md`, `TRACEABILITY.md` and `contracts/`.

| Service | Folder | Schema | Origin | Documents |
|---|---|---|---|---|
| identity | `services/identity` | `identity` | migrated | [README](../services/identity/README.md), [TRACEABILITY](../services/identity/TRACEABILITY.md), [contracts](../services/identity/contracts/) |
| people | `services/people` | `people` | migrated | [README](../services/people/README.md), [TRACEABILITY](../services/people/TRACEABILITY.md), [contracts](../services/people/contracts/) |
| programs/sites | `services/programs-sites` | `programs_sites` | migrated | [README](../services/programs-sites/README.md), [TRACEABILITY](../services/programs-sites/TRACEABILITY.md), [contracts](../services/programs-sites/contracts/) |
| strategies/content | `services/strategies-content` | `content` | migrated | [README](../services/strategies-content/README.md), [TRACEABILITY](../services/strategies-content/TRACEABILITY.md), [contracts](../services/strategies-content/contracts/) |
| communications | `services/communications` | `communications` | synthetic | [README](../services/communications/README.md), [TRACEABILITY](../services/communications/TRACEABILITY.md), [contracts](../services/communications/contracts/) |
| reporting | `services/reporting` | `reporting` | synthetic | [README](../services/reporting/README.md), [TRACEABILITY](../services/reporting/TRACEABILITY.md), [contracts](../services/reporting/contracts/) |
| surveys | `services/surveys` | `surveys` | synthetic | [README](../services/surveys/README.md), [TRACEABILITY](../services/surveys/TRACEABILITY.md), [contracts](../services/surveys/contracts/) |
| timesheets | `services/timesheets` | `timesheets` | synthetic | [README](../services/timesheets/README.md), [TRACEABILITY](../services/timesheets/TRACEABILITY.md), [contracts](../services/timesheets/contracts/) |
| finance | `services/finance` | `finance` | synthetic | [README](../services/finance/README.md), [TRACEABILITY](../services/finance/TRACEABILITY.md), [contracts](../services/finance/contracts/) |
| e-signature | `services/e-signature` | `esignature` | synthetic | [README](../services/e-signature/README.md), [TRACEABILITY](../services/e-signature/TRACEABILITY.md), [contracts](../services/e-signature/contracts/) |
| stub (platform proof only, not deployed) | `services/stub` | `stub` | — | [README](../services/stub/README.md), [TRACEABILITY](../services/stub/TRACEABILITY.md), [contracts](../services/stub/contracts/) |

Event topics, each linked to its payload schema:

| Topic | Producer | Consumers |
|---|---|---|
| [`programs-sites.site.changed.v1`](../services/programs-sites/contracts/events/programs-sites.site.changed.v1.json) | programs-sites | every other service |
| [`identity.group.changed.v1`](../services/identity/contracts/events/identity.group.changed.v1.json) | identity | people, strategies-content |
| [`identity.permission.changed.v1`](../services/identity/contracts/events/identity.permission.changed.v1.json) | identity | strategies-content |
| [`identity.membership.changed.v1`](../services/identity/contracts/events/identity.membership.changed.v1.json) | identity | strategies-content |
| [`identity.login-mail.requested.v1`](../services/identity/contracts/events/identity.login-mail.requested.v1.json) | identity | communications |
| [`people.person.changed.v1`](../services/people/contracts/events/people.person.changed.v1.json) | people | identity |
| [`people.person.archived.v1`](../services/people/contracts/events/people.person.archived.v1.json) | people | timesheets |
| [`surveys.survey.scheduled.v1`](../services/surveys/contracts/events/surveys.survey.scheduled.v1.json) | surveys | communications |
| [`communications.message.delivery-status-changed.v1`](../services/communications/contracts/events/communications.message.delivery-status-changed.v1.json) | communications | none (contract-tested) |
| [`stub.note.created.v1`](../services/stub/contracts/events/stub.note.created.v1.json) | stub | stub |

Other components:

- [`platform/`](../platform/): `@opt2/platform`, the shared libraries every package imports by subpath.
- [`gateway/`](../gateway/): the gateway and compatibility dispatcher, with cut-over versions `v0001`–`v0003` in [`gateway/cutover/versions/`](../gateway/cutover/versions/).
- [`web/`](../web/): the Next.js admin that reproduces the legacy admin screens.
- [`migration/`](../migration/): the `opt2-migrate` CLI and the migration service.
- [`legacy-fixtures/`](../legacy-fixtures/): the SYNTHETIC legacy oracle for the six synthetic services.
- [`harness/`](../harness/): inventory, baseline, golden capture and replay, end-to-end suites, reports and the reproducibility commands.
- [`infra/terraform/`](../infra/terraform/): Cloud Run, Cloud SQL, Pub/Sub, Cloud Tasks, Cloud Storage and Identity Platform, planned only and never applied.

## Success criteria and evidence

| Criterion | Evidence |
|---|---|
| 1 Parity | [`reports/parity.json`](reports/parity.json), [`reports/parity.md`](reports/parity.md) |
| 2 Isolation | [`reports/isolation.json`](reports/isolation.json) |
| 3 Consistency | [`reports/reconciliation/summary.md`](reports/reconciliation/summary.md), [`reports/events.json`](reports/events.json) |
| 4 Observability | [`reports/observability.json`](reports/observability.json) |
| 5 Reviewability | [`reports/reviewability.json`](reports/reviewability.json), [`reports/reviewability.md`](reports/reviewability.md); each service's `README.md`, `TRACEABILITY.md` and `contracts/` |
| 6 Reproducibility | [`reports/test-all.json`](reports/test-all.json), [`reports/test-all.md`](reports/test-all.md), [`reports/reproducibility.md`](reports/reproducibility.md) |
| 7 Speed | [`reports/speed.json`](reports/speed.json), [`reports/speed.md`](reports/speed.md) |
| Done when: legacy baseline | [`reports/baseline.json`](reports/baseline.json) |
| Done when: platform on stub | [`reports/platform-proof.json`](reports/platform-proof.json) |
| Done when: ten services | [`reports/test-all.json`](reports/test-all.json) |
| Done when: migration | [`reports/reconciliation/`](reports/reconciliation/) (`*.json`), [`reports/rollback-rehearsal.md`](reports/rollback-rehearsal.md) |
