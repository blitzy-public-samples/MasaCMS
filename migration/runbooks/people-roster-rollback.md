# People roster rollback
Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

Returns the people roster group set `R` to legacy authority and rehearses the roster routes on legacy (AAP 0.8.5): `opt2-migrate transition --to v0003` executes sections 3–7, and `harness/repro/test-all.sh` stage 8 rehearses the whole procedure.

## Before you start

- The stack is up: `harness/repro/up.sh` has run and `${OPT2_STATE_DIR}/up.json` exists.
- The migration service answers at `OPT2_MIGRATION_URL` (local port 8102, `OPT2_PORT_MIGRATION` in `harness/repro/ports.env`); `transition` posts to it as `platform.operator`.
- `OPT2_STATE_DIR` is set; `OPT2_REPORTS_DIR` optionally replaces `opt2/reports` as the reports directory.
- `OPT2_LEGACY_RESTART_CMD` is set in the migration service's environment (locally `harness/repro/lib/legacy-start.sh`).
- Run `opt2-migrate` (`node migration/dist/cli.js`) in the migration operator environment, as `opt2_migrate` in `harness/repro/lib/common.sh` does. Each command prints one JSON summary line on stdout and exits 0 on success, 1 on failure or a reconciliation difference, 2 on a usage error.
- Read and change target data only through the commands below, never with SQL against a service schema.

## 1. Scope: the roster group set `R`

- Compute `R`; never choose it. `opt2-migrate rollback-set` reads `gateway/cutover/groups.json` and returns every group whose `writeEntries` hold `admin:cusers.update{type=2,action=add}`, `admin:cusers.update{type=2,action=update}` or `fixture:people/persons/{id}/archive@post`, or whose `units` hold `people.person_archive` or `timesheets.blackout` (`rollbackSet` in `migration/config/migration.config.json`).
- Expect two groups: create/edit, with the person, account, credential and membership units, and archive, with `people.person_archive` and `timesheets.blackout`. The command exits 1 with `RollbackSetMismatchError` unless `R` equals `gateway/cutover/versions/v0003.json` `rollbackRefs[].groups`, every group of `R` is `legacy` in `v0003`, and `v0003` returns to `legacy` exactly the groups of `R` that `v0002` holds `target`.
- `T` is the units of `R`: every unit of the groups `v0003` `rollbackRefs` names, with any other unit whose authority the transition changes. The units of a group of `R` that `v0002` already keeps `legacy` are in `T` as well: they are quiesced, drained, brought to the final state and reconciled with the rest, and their gates stay `legacy` throughout. `transitions.json` records `T` as `setT`; the plan in `migration.transition` lists those held-legacy units as `heldLegacy`.
- Read the session modes from `sessionModeBefore` and `sessionModeAfter`. They differ only when `R` holds the login group, whose `writeEntries` include `admin:clogin.login` (`containsLoginGroup: true`), and `v0002` holds that group `target`; sessions then move from target-primary to legacy-primary at activation, and the GS-ID-09 session step runs across the switch. The committed versions do so: `R` is `grp:identity.credential` (the login group) and `grp:people.person_archive`, both `target` in `v0002`, so all 19 units of `T` return to legacy and `heldLegacy` is empty. Groups outside `R` keep their authority.

| Command | Evidence |
|---|---|
| `opt2-migrate rollback-set` | JSON line with `groups`, `units`, `containsLoginGroup`, `sessionModeBefore`, `sessionModeAfter` |

## 2. Preconditions

- Do not start unless every row below holds.
- Resolve each halted roster operation first, in the people service's environment: `opt2-people resolve-operation <operationId> --to rolled-back` or `--to done`. A halted operation resolves only with `--to`.
- For the rehearsal, open the GS-ID-09 session step now, before the transition, so that it spans activation. `--rehearsal` keeps this crossing's sessions and output apart from its `v0002` parity replay.

| Command | Evidence |
|---|---|
| Read `opt2/reports/transitions.json` | Latest entry `to: v0002` with `outcome: activated`, and no entry without `outcome`; the service refuses a second start with 409 `TransitionInProgressError` |
| `opt2-migrate reconcile --point post-cutover` | Exit 0; `opt2/reports/reconciliation/post-cutover.json` has `result: zero-difference` |
| Read `opt2/exceptions-list.json` and people `GET /internal/v1/roster-operations/halted` | No halted roster operation |
| Read `${OPT2_STATE_DIR}/fixtures.json` | `available: true`; otherwise see section 12 |
| `npm --prefix harness run golden:replay -- --rehearsal --only GS-ID-09 --phase pre-transition` | Exit 0; sessions saved in `${OPT2_STATE_DIR}/golden/sessions/rehearsal/GS-ID-09.json` |

## 3. Quiesce

- Run `opt2-migrate transition --to v0003` once. This one command performs sections 3–7 and returns when the transition is `completed` or `aborted`, or, still aborting, once its failing undo is escalated (section 12). Follow its steps in `opt2/reports/transitions.json` (`transitions[].steps[]`) or through migration `GET /internal/v1/transitions/{transitionId}`, which reads `migration.transition`.
- `transition-set` derives `T` and leases it in `migration.unit_lease` as holder kind `transition`, so one holder owns each unit; a write window on `T` is waited out.
- `stop-new-work` pauses the native and fixture tasks whose steps write `T` and the task queues of `T`'s owners except their outbox sweeps, then freezes the affected entries (the changed entries, the write entries of every group of `R` and the `legacy-write` entries whose units meet `T`) and waits for every gateway instance to acknowledge the epoch.
- `confirm-inflight-finished` waits until the frozen entries hold no `gateway.inflight` rows other than orphans (rows of a dead instance, or ones a live instance abandoned), and for fixture `cfthread` export jobs writing `T` to leave `queued` and `running`.

| Transition step | Evidence |
|---|---|
| 1 `transition-set` | `transitions.json` entry with `setT`, `entriesChanged`, `legacyWriteEntries`; step 1 `result: ok` |
| 2 `stop-new-work` | Step 2 `result: ok` |
| 3 `confirm-inflight-finished` | Step 3 `result: ok` |

## 4. Drain

- `drain-effects` waits, before any gate of `T` closes, until the outboxes of `T`'s owners (identity, people and timesheets for the committed `R`), and of the services publishing to them, are fully published, and every published event for `T` has an inbox receipt or, for a state event, a dead letter. Every `people.person.archived.v1` therefore has its timesheets receipt, and the blackouts of pending archives exist before projection.
- A dead-lettered `people.person.archived.v1` is a process effect without a receipt: step 4 aborts naming its event id, topic and subscription. Run `opt2-events replay --subscription <subscription>` with that subscription, then run the transition again. A consumer that does not answer counts as not yet drained until `transition.drainTimeoutMs`; the timeout names it.

| Transition step | Evidence |
|---|---|
| 4 `drain-effects` | Per-owner counts from `GET /internal/v1/migration/position`; step 4 `result: ok` |

## 5. Close gates and project

- `close-gates` closes the gates of the units of `T` returning to legacy at their owners with the transition as holder, by compare-and-set. Closing waits for in-flight target transactions and refuses later ones. The gates of the held-legacy units stay `legacy`, which already refuses every target write. It then clears step 3's target-bound orphans with that `gates-closed` evidence.
- `final-state-and-reconcile`, when `heldLegacy` is not empty, takes a final snapshot of the quiesced legacy database and brings the held-legacy units to it through the forward feed. It then waits until the reverse projector has applied every owner's current write position for the units returning to legacy to the live legacy tables, for example `timesheets.blackout` → `Program_N.blackout`, `people.person_archive` → `synthetic.person_archive`, and, while `v0002` holds their group `target`, `identity.credential` → `tusers.Password` and `PasswordCreated` and person columns → `tusers`.

| Transition step | Evidence |
|---|---|
| 5 `close-gates` | Step 5 `result: ok` |
| 6 `final-state-and-reconcile`, projection | `opt2_sync.projector_checkpoint` horizons past the recorded write positions |

## 6. Reconcile before

- The rest of `final-state-and-reconcile` reconciles `T`, every unit of `R`, against the live legacy database at point `rollback-before`, with zero tolerance.
- Any difference aborts the transition with `v0002` still active (section 12).

| Transition step | Evidence |
|---|---|
| 6 `final-state-and-reconcile`, reconciliation | `opt2/reports/reconciliation/rollback-before.json` with `result: zero-difference` and `expectedTableVersion: v0002`; summary line `reconciliation.differences: 0` |

## 7. Activate `v0003`

- `activate` activates `v0003` once and waits for every gateway instance to acknowledge the epoch. Every group of `R` is now `legacy`-authoritative, and `rollbackRefs` names `opt2/reports/reconciliation/rollback-before.json`, the zero-difference report that permits the return.
- `hand-off-and-reopen` hands off the schedulers whose units moved, sets the gates it closed to `legacy` by compare-and-set (the held-legacy gates are already `legacy`), releases the leases, unfreezes, resumes the paused queues and tasks, and reconciles the recurring task chains as `opt2-tasks reconcile` does.
- The command exits 0 only when the transition is `completed`.

| Transition step | Evidence |
|---|---|
| 7 `activate` | Gateway `GET /internal/v1/cutover/status` reports `tableVersion: v0003` |
| 8 `hand-off-and-reopen` | `transitions.json` entry with `outcome: activated`; summary line `state: completed` |

## 8. Re-baseline the target copy

- Run `opt2-migrate rollback rebaseline`. It takes a fresh snapshot and restarts the forward feed for the units of `R` from it.
- It exits 1 with `RollbackNotActiveError`, before any snapshot, when `v0003` is not active.

| Command | Evidence |
|---|---|
| `opt2-migrate rollback rebaseline` | `${OPT2_STATE_DIR}/rollback/rebaseline.json` with `snapshotSeq` and `units` |

## 9. Rehearse

- Replay GS-PE-RH-01, GS-PE-RH-02 and GS-PE-RH-03 (create, edit, archive) through the gateway, now served by legacy; archive runs the legacy `usp_person_archived_blackout`. `--rehearsal` requires `v0003` active and, without `--only`, selects only these scenarios.
- The replay uses only the reserved identities in `legacy-fixtures/seed/seed.config.json` `reserved.rehearsal` and compares against golden sets captured at `harness/repro/test-all.sh` stage 5 from the same seeded state.
- Complete the GS-ID-09 session step opened in section 2; `test-all.sh` stage 8 runs it directly after the transition completes. It is compared with `harness/golden/sets/rehearsal/GS-ID-09.json`, which stage 5 captures (`golden:capture -- --rehearsal`) after every other scenario and just before the GS-PE-RH sets, and any unlisted difference fails it.
- Run one feed pass, then compare the replays with their golden sets.

| Command | Evidence |
|---|---|
| `npm --prefix harness run golden:replay -- --rehearsal --only GS-ID-09 --phase resume` | Exit 0; `${OPT2_STATE_DIR}/golden/replay/rehearsal/GS-ID-09.json` |
| `npm --prefix harness run golden:replay -- --rehearsal` | Exit 0; `${OPT2_STATE_DIR}/golden/replay/<id>.json` per scenario |
| `opt2-migrate feed` | JSON line; `opt2/reports/reconciliation/after-feed-<seq>.json` with `result: zero-difference` |
| `npm --prefix harness run golden:compare` | GS-PE-RH-01/02/03 results in `opt2/reports/parity.json` `scenarios`; the GS-ID-09 crossing, compared under `v0003`, in `rehearsalCrossings`; exit 1 when any fails |

## 10. Reconcile after

- Run `opt2-migrate reconcile --point rollback-after`. Without `--units` it reconciles every unit of the groups `v0003` `rollbackRefs` names against the live legacy database.
- It must exit 0; exit 1 is a difference (section 12).

| Command | Evidence |
|---|---|
| `opt2-migrate reconcile --point rollback-after` | `opt2/reports/reconciliation/rollback-after.json` with `result: zero-difference` and `expectedTableVersion: v0003` |

## 11. Evidence

- Run `opt2-migrate rollback report`. It writes `opt2/reports/rollback-rehearsal.md` with the members of `R`, the session mode before and after, both reconciliation results, the GS-PE-RH outcomes and the GS-ID-09 crossing's (`parity.json` `rehearsalCrossings`), and each step's start, finish and result in run order. The step times come from `transitions.json`, the `startedAt` and `generatedAt` of both reconciliation reports, `rebaseline.json`, the GS-PE-RH replay outputs, and the `feed.startedAt` and `generatedAt` of the last `after-feed-<seq>.json` between the rehearsal and `rollback-after`.
- Its result is `pass`, `fail` or `incomplete`; the command exits 1 only on `fail`.
- `pass` needs every piece of evidence from this rehearsal: `rollback-before` (under `v0002`), begun and written inside the latest `final-state-and-reconcile` step of the latest activated `v0003` transition; after that transition, the re-baseline and the GS-ID-09 crossing's replay output (`${OPT2_STATE_DIR}/golden/replay/rehearsal/GS-ID-09.json`, under `v0003`); after the re-baseline, the GS-PE-RH replay outputs; after every rehearsal replay, the GS-ID-09 crossing included, a zero-difference feed pass under `v0003`, then `rollback-after` (under `v0003`); and `parity.json` written after every replay. Only this rehearsal's evidence can make the result `fail`: evidence that is absent or from an earlier run, failing or not, makes it `incomplete`, and the line after `Status:` names it.

| Command | Evidence |
|---|---|
| `opt2-migrate rollback report` | `opt2/reports/rollback-rehearsal.md` `Status:` line; JSON line `result` |

## 12. Failure handling

| Condition | Action | Result |
|---|---|---|
| Abort before activation: any failure in steps 1–6, a `rollback-before` difference included | Read `error.step` from the summary line, whose `error.message` is `[REDACTED]` unless it is a fixed safe text, and the full reason as `abortReason` in `transitions.json`; fix the cause; rerun from section 2 | The transition reopens the gates it closed, unfreezes, resumes queues and tasks and releases its leases; `v0002` stays active |
| The undo of an abort keeps failing for five minutes: the summary line shows `error.state` `aborting` and `error.undoFailures.escalatedAt` | Restore the owner, gateway or ColdFusion the undo calls, as the escalation log line names what is still held; follow `GET /internal/v1/transitions/{transitionId}` until it is `aborted`; rerun from section 2 | The service keeps retrying the undo; until it succeeds the gates, freeze and leases stay held, no other transition starts, and `v0002` stays active |
| Orphaned legacy-bound in-flight write at step 3 | None; the transition runs `OPT2_LEGACY_RESTART_CMD`, a controlled ColdFusion restart, and clears the orphan | Without `OPT2_LEGACY_RESTART_CMD`, as in the cloud, the transition aborts and names the orphan |
| Orphaned target-bound in-flight write at step 3 (its instance died, or it abandoned an exchange that timed out or broke) | None; step 5 `close-gates` closes `T`'s gates and clears the orphan with that `gates-closed` evidence | The transition continues and the row leaves `gateway.inflight`; it is never cleared by time |
| Step 1 aborts naming a write window in phase `import-pending` on a unit of `T` | Confirm its legacy request can no longer commit, run `opt2-migrate resolve-window <windowId>` (ids in `opt2/reports/windows.json` once `opt2-migrate window report` has refreshed it), then rerun from section 2 | The window imports, closes and releases its leases |
| Halted roster operation | `opt2-people resolve-operation <operationId> --to rolled-back` or `--to done`, then rerun from section 2 | The operation ends and its user's units reopen |
| `opt2-migrate rollback-set` exits 1 with `RollbackSetMismatchError` | `groups.json` and `v0003.json` disagree: regenerate them with `npm --prefix gateway run cutover:groups` and `npm --prefix gateway run cutover:versions`, check with `npm --prefix gateway run cutover:validate`, then rerun | `R` is recomputed; never edit `R` by hand |
| `opt2-migrate rollback rebaseline` exits 1 with `RollbackNotActiveError` | Complete section 7 first | No snapshot is taken |
| `opt2-migrate feed` or `opt2-migrate reconcile --point rollback-after` exits 1 on a difference | Inspect the difference list of the report it wrote | `v0003` stays active; a `rollback-after` or feed-pass difference makes the `rollback report` result `fail` |
| Fixtures unavailable: `${OPT2_STATE_DIR}/fixtures.json` has `available: false` | Rehearse create and edit only (GS-PE-RH-01, GS-PE-RH-02) | GS-PE-RH-03 and the archive-to-blackout leg are reported unmet, and the report result is `incomplete` (AAP 0.7.6) |
