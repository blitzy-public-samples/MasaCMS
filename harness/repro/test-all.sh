#!/usr/bin/env bash
# Command two of the OPT-2 reproducibility pair: runs every test stage in the order of proof and writes opt2/reports/test-all.{json,md}.
# shellcheck disable=SC2317 # the stage functions run through STAGE_FUNCS
set -euo pipefail

# Prints the one-line usage to stderr and exits 1.
usage_error() {
  printf 'usage: harness/repro/test-all.sh [-h|--help]\n' >&2
  exit 1
}

case $# in
  0) ;;
  1)
    case $1 in
      -h | --help)
        cat <<'EOF'
usage: harness/repro/test-all.sh

Runs stages 0-9 against the stack harness/repro/up.sh started: pin and label checks, legacy baseline, platform on the
stub, every package's tests, migration and faults, golden capture, cut-over to v0002, parity and cross-cutting suites,
the people-roster rollback rehearsal and the reports. Each stage is recorded in ${OPT2_STATE_DIR}/test-all/stage-<n>.json
with its output in stage-<n>.out; a failing stage stops the later ones. Takes no arguments. The stack stays up.
A run stopped between stage 4's drain-and-suspend and stage 5's resume leaves background work suspended, and
test-all.sh then refuses to start on that stack until harness/repro/down.sh and harness/repro/up.sh restart it.

Environment:
  required              PG_USER, PG_PASSWORD, MURA_ADMIN_PASSWORD, MASA_TEST_EDITOR_PASSWORD
  MURA_ADMIN_USERNAME   admin login (default admin)
  OPT2_STATE_DIR        up.json and the stage records (default $HOME/.opt2/state)
  OPT2_PRISTINE_DIR     pristine legacy baseline (default $HOME/.opt2/pristine)
  OPT2_REPORTS_DIR      report directory, relative to the checkout when relative (default opt2/reports)
The stack's own settings (PORT, database and service addresses) come from up.json.

Example, with the environment up.sh ran under:
  OPT2_STATE_DIR=$HOME/.opt2/state harness/repro/test-all.sh; echo "exit $?"

Exit: 0 every acceptance item met, 2 completed with acceptance items unmet (listed in opt2/reports/test-all.md),
1 a stage failed, the run was interrupted, or it could not start.
EOF
        exit 0
        ;;
      *) usage_error ;;
    esac
    ;;
  *) usage_error ;;
esac

# shellcheck source=SCRIPTDIR/lib/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"
# shellcheck source=SCRIPTDIR/lib/lock.sh
source "$LIB_DIR/lock.sh"
# shellcheck source=SCRIPTDIR/lib/processes.sh
source "$LIB_DIR/processes.sh"
# shellcheck source=SCRIPTDIR/lib/checkpoint.sh
source "$LIB_DIR/checkpoint.sh"

UP_FILE="$OPT2_STATE_DIR/up.json"
FIXTURES_FILE="$OPT2_STATE_DIR/fixtures.json"
ENVIRONMENT_FILE="$OPT2_STATE_DIR/baseline/environment.json"
TA_DIR="$OPT2_STATE_DIR/test-all"
# Hands each stage's reasons, unmet items, evidence and package codes from its subshell to the recorder.
RUN_DIR="$TA_DIR/run"
VITEST_DIR="$TA_DIR/vitest"
E2E_DIR="$TA_DIR/e2e"
STEP_STDOUT="$RUN_DIR/step.stdout"
# OPT2_REPORTS_DIR as harness/src/lib/paths.ts resolves it: relative values against the checkout.
REPORTS_DIR="${OPT2_REPORTS_DIR:-$REPO/opt2/reports}"
[[ $REPORTS_DIR == /* ]] || REPORTS_DIR="$REPO/$REPORTS_DIR"
RECON_DIR="$REPORTS_DIR/reconciliation"

STAGE_FUNCS=(stage_pin stage_baseline stage_platform stage_services stage_migration stage_capture stage_cutover
  stage_equivalence stage_rollback stage_reports)
PLATFORM_PACKAGES=(platform gateway services/stub)
SERVICE_PACKAGES=(services/identity services/people services/programs-sites services/strategies-content
  services/communications services/reporting services/surveys services/timesheets services/finance services/e-signature
  web migration harness)
E2E_SUITES=(isolation/tenant-isolation events/seams events/dlq-replay events/trace events/roster-protocol
  security/authz-matrix)
# Settings of the migration process up.sh recorded, so every command here addresses the same stack it started.
STACK_ENV_KEYS=(TZ GOOGLE_CLOUD_PROJECT PUBSUB_EMULATOR_HOST OPT2_SERVICE_URLS OPT2_GATEWAY_URL OPT2_MIGRATION_URL
  LEGACY_ORIGIN OPT2_LEGACY_PORT MURA_DBHOST MURA_DBPORT MURA_DATABASE MURA_DBUSERNAME MURA_DBPASSWORD PG_HOST PG_PORT
  PG_DATABASE)
# Stack addresses withheld from package unit suites, which run against PostgreSQL and Pub/Sub only, as in CI.
PACKAGE_TEST_UNSET=(OPT2_SERVICE_URLS OPT2_GATEWAY_URL OPT2_MIGRATION_URL LEGACY_ORIGIN OPT2_LEGACY_PORT)

STAGE_N=""
STAGE_OUT=""
# The startedAt up.sh recorded in up.json, identifying the stack this run tests.
STACK_STARTED_AT=""

# --- Stack and environment -------------------------------------------------------------------------------------

# Dies unless up.sh finished recording the stack in up.json and the gateway it recorded is still running, with its
# recorded start time when one is; sets STACK_STARTED_AT.
require_stack() {
  local line finished pid start
  [[ -f $UP_FILE ]] || die "no OPT-2 stack is recorded ($UP_FILE is missing): run harness/repro/up.sh first"
  line="$(harness_run repro:up-state -- read)" || die "cannot read $UP_FILE ($line): run harness/repro/up.sh first"
  finished="$(printf '%s\n' "$line" | json_get - value.startedAt 2>/dev/null)" || finished=""
  [[ -n $finished ]] || die "up.sh did not finish recording the stack in $UP_FILE: run harness/repro/up.sh first"
  STACK_STARTED_AT=$finished
  pid="$(printf '%s\n' "$line" | json_get - value.processes.gateway.pid 2>/dev/null)" ||
    die "$UP_FILE records no gateway: run harness/repro/up.sh first"
  start="$(printf '%s\n' "$line" | json_get - value.processes.gateway.startTime 2>/dev/null)" || start=""
  { _opt2_pid_alive "$pid" && _opt2_proc_start_matches "$pid" "$start"; } ||
    die "the gateway (pid $pid) recorded in $UP_FILE is not running: run harness/repro/up.sh first"
}

# Exports STACK_ENV_KEYS from the migration process environment in up.json; legacy's port becomes PORT.
load_stack_env() {
  local text line
  # shellcheck disable=SC2016 # JavaScript source
  text="$(node -e '
const [file, ...keys] = process.argv.slice(1);
const env = JSON.parse(require("fs").readFileSync(file, "utf8")).processes?.migration?.env ?? {};
const missing = keys.filter((key) => typeof env[key] !== "string" || env[key] === "");
if (missing.length > 0) {
  process.stderr.write(`opt2: ${file} records no ${missing.join(", ")} for the migration process\n`);
  process.exit(1);
}
const bad = keys.filter((key) => /[\r\n]/.test(env[key]));
if (bad.length > 0) {
  process.stderr.write(`opt2: ${file} holds a newline in ${bad.join(", ")}\n`);
  process.exit(1);
}
process.stdout.write(keys.map((key) => `${key}=${env[key]}\n`).join(""));
' -- "$UP_FILE" "${STACK_ENV_KEYS[@]}")" || die "cannot load the stack environment from $UP_FILE: run harness/repro/up.sh first"
  while IFS= read -r line; do
    # shellcheck disable=SC2163 # exports the KEY=value word itself
    export "$line"
  done <<<"$text"
  LEGACY_PORT=$OPT2_LEGACY_PORT
  export PORT=$OPT2_LEGACY_PORT
}

# Prints the migration-stage skip reason when environment.json records a legacy baseline deviation; nothing otherwise.
migration_skip_reason() {
  local fallback reason
  [[ -f $ENVIRONMENT_FILE ]] || return 0
  fallback="$(json_get "$ENVIRONMENT_FILE" settings.mysqlFallback 2>/dev/null)" || fallback=false
  reason="$(json_get "$ENVIRONMENT_FILE" settings.deviationReason 2>/dev/null)" || reason=null
  if [[ $reason != null && -n $reason ]]; then
    printf '%s\n' "$reason"
  elif [[ $fallback == true ]]; then
    printf 'the MySQL fallback was used: SQL Server is the only supported migration source\n'
  fi
}

# --- Stage metadata and recording ------------------------------------------------------------------------------

# meta_file <n> <kind>: path of stage n's metadata of one kind (reasons, unmet, evidence, packages, result).
meta_file() { printf '%s/stage-%s.%s\n' "$RUN_DIR" "$1" "$2"; }

note_reason() { printf '%s\n' "$*" >>"$(meta_file "$STAGE_N" reasons)"; }
clear_reasons() { rm -f -- "$(meta_file "$STAGE_N" reasons)"; }
# note_unmet <item> <reason>: an acceptance item the stage leaves unmet.
note_unmet() { printf '%s=%s\n' "$1" "$2" >>"$(meta_file "$STAGE_N" unmet)"; }
note_package() { printf '%s=%s\n' "$1" "$2" >>"$(meta_file "$STAGE_N" packages)"; }
# set_result <skipped|timing-variance|unmet>: the stage's result when it exits 0 without passing outright.
set_result() { printf '%s\n' "$1" >"$(meta_file "$STAGE_N" result)"; }

# Notes each existing path as stage evidence.
note_evidence() {
  local file
  for file in "$@"; do
    if [[ -e $file ]]; then printf '%s\n' "$file" >>"$(meta_file "$STAGE_N" evidence)"; fi
  done
}

# record_stage <n> <result> <started> <finished> [exit code]: writes stage n's record through report:test-all record.
record_stage() {
  local n=$1 result=$2 started=$3 finished=$4 code=${5:-} reason="" line entry file
  local -a args=(record --stage "$n" --result "$result" --started-at "$started" --finished-at "$finished") lines=()
  if [[ -n $code ]]; then args+=(--exit-code "$code"); fi
  file="$(meta_file "$n" reasons)"
  if [[ -s $file ]]; then
    mapfile -t lines <"$file"
    reason=${lines[0]}
    for entry in "${lines[@]:1}"; do reason+="; $entry"; done
    args+=(--reason "$reason")
  fi
  if [[ -f $TA_DIR/stage-$n.out ]]; then args+=(--evidence "$TA_DIR/stage-$n.out"); fi
  for entry in evidence:--evidence unmet:--unmet packages:--package; do
    file="$(meta_file "$n" "${entry%%:*}")"
    [[ -s $file ]] || continue
    mapfile -t lines <"$file"
    for line in "${lines[@]}"; do args+=("${entry#*:}" "$line"); done
  done
  line="$(harness_run report:test-all -- "${args[@]}" </dev/null)" || die "recording stage $n failed: $line"
}

# record_without_run <n> <skipped|not-run> <reason>: records a stage that did not run, removing an earlier run's output.
record_without_run() {
  local stamp
  rm -f -- "$TA_DIR/stage-$1.out" || die "cannot remove the earlier run's $TA_DIR/stage-$1.out"
  stamp="$(now_iso)"
  printf '%s\n' "$3" >"$(meta_file "$1" reasons)"
  record_stage "$1" "$2" "$stamp" "$stamp"
  printf 'stage %s: %s (%s)\n' "$1" "$2" "$3" >&2
}

# --- Stage runner ----------------------------------------------------------------------------------------------

# run_step <label> <cmd…>: prints `stage <n>: <label>` and runs the command in a subshell, stdout to STEP_STDOUT and
# stderr to the stage output and stderr, both kept in stage-<n>.out; notes a failure, or output it cannot write, as a
# stage reason. Returns the command's status; 1 when its output cannot be written and it passed or did not run.
run_step() {
  local label=$1 status="" lost="" reason
  local -a pipe=()
  shift
  printf 'stage %s: %s\n' "$STAGE_N" "$label" >&2
  if printf '\n==> [%s] stage %s: %s\n' "$(now_iso)" "$STAGE_N" "$label" >>"$STAGE_OUT"; then
    set +e
    { ( "$@" ) </dev/null 2>&1 >&3 | tee -a -- "$STAGE_OUT" >&2; pipe=("${PIPESTATUS[@]}"); } 3>"$STEP_STDOUT"
    set -e
    if ((${#pipe[@]} == 0)); then
      lost=$STEP_STDOUT
    else
      status=${pipe[0]}
      if ((pipe[1] != 0)); then lost="$STAGE_OUT or stderr"; fi
      if [[ -s $STEP_STDOUT ]] && ! tee -a -- "$STAGE_OUT" <"$STEP_STDOUT" >&2; then lost="$STAGE_OUT or stderr"; fi
    fi
  else
    lost=$STAGE_OUT
  fi
  if [[ -n $status ]] && ((status != 0)); then
    note_reason "$label exited $status"
    printf 'stage %s: %s failed (exit %s); output in %s\n' "$STAGE_N" "$label" "$status" "$STAGE_OUT" >&2
  fi
  if [[ -n $lost ]]; then
    reason="$label: cannot write its output to $lost"
    if [[ -z $status ]]; then reason+="; not run"; fi
    note_reason "$reason"
    printf 'stage %s: %s\n' "$STAGE_N" "$reason" >&2
    if ((${status:-0} == 0)); then status=1; fi
  fi
  return "$status"
}

# run_stage <n> <function>: runs the stage function in an errexit subshell, so a helper's die ends only the stage, and
# records its result; false when the stage failed. The subshell leads its own process group, so stop_stage can end
# all it started, and is awaited with wait, so a signal trap runs at once.
run_stage() {
  local n=$1 fn=$2 status result="pass" file
  STAGE_N=$n
  STAGE_OUT="$TA_DIR/stage-$n.out"
  rm -f -- "$RUN_DIR/stage-$n".*
  : >"$STAGE_OUT"
  CURRENT_STARTED="$(now_iso)"
  CURRENT_STAGE=$n
  printf 'stage %s: begin (output in %s)\n' "$n" "$STAGE_OUT" >&2
  set +e
  set -m
  (
    set -e
    "$fn"
  ) </dev/null &
  CURRENT_PGID=$!
  set +m
  if [[ -n $CAUGHT_SIGNAL ]]; then stop_interrupted; fi
  wait "$CURRENT_PGID"
  status=$?
  CURRENT_PGID=""
  set -e
  file="$(meta_file "$n" result)"
  if ((status != 0)); then
    result=fail
    if [[ ! -s $(meta_file "$n" reasons) ]]; then note_reason "stage exited $status"; fi
  elif [[ -s $file ]]; then
    result="$(<"$file")"
  fi
  record_stage "$n" "$result" "$CURRENT_STARTED" "$(now_iso)" "$status"
  CURRENT_STAGE=""
  printf 'stage %s: %s\n' "$n" "$result" >&2
  [[ $result != fail ]]
}

# --- Interruption ----------------------------------------------------------------------------------------------

# The stage begun but not yet recorded, its start and process group while it runs; the first stage not yet recorded.
CURRENT_STAGE=""
CURRENT_STARTED=""
CURRENT_PGID=""
NEXT_STAGE=0
CAUGHT_SIGNAL=""
FINISHED=""
# Set once the final assembly has returned; set once an assembly has rewritten test-all.{json,md}.
REPORT_ATTEMPTED=""
REPORT_WRITTEN=""
# Holds STACK_STARTED_AT from the start of stage 4's drain-and-suspend until stage 5's resume; outlives the run.
SUSPENDED_MARKER="$TA_DIR/background-suspended"

# Ends the running stage's process group: SIGTERM, SIGKILL after 10 s, then up to 5 s more for it to empty.
stop_stage() {
  local pgid=$CURRENT_PGID i
  [[ -n $pgid ]] || return 0
  CURRENT_PGID=""
  printf 'test-all: stopping stage %s (process group %s)\n' "$CURRENT_STAGE" "$pgid" >&2
  kill -TERM -- "-$pgid" 2>/dev/null
  for ((i = 0; i < 150; i++)); do
    kill -0 -- "-$pgid" 2>/dev/null || return 0
    if ((i == 100)); then kill -KILL -- "-$pgid" 2>/dev/null; fi
    sleep 0.1
  done
  printf 'test-all: process group %s of stage %s outlived SIGKILL\n' "$pgid" "$CURRENT_STAGE" >&2
}

# Prints how to recover while stage 4's drain-and-suspend is in force; nothing otherwise.
suspended_notice() {
  [[ -e $SUSPENDED_MARKER ]] || return 0
  printf 'test-all: %s\n' \
    "background work of this stack is suspended, wholly or in part, since stage 4 (opt2-ops drain-and-suspend)." \
    "do not run opt2-ops resume until legacy and target are reset to Ck and verified." \
    "the reliable recovery is harness/repro/down.sh, then harness/repro/up.sh; until then test-all.sh refuses to start." \
    "remove $SUSPENDED_MARKER only once background work has been resumed." >&2
}

# Dies while the suspension marker records this stack; removes one that records an earlier stack.
check_suspended() {
  local recorded
  [[ -e $SUSPENDED_MARKER ]] || return 0
  recorded="$(<"$SUSPENDED_MARKER")" || die "cannot read $SUSPENDED_MARKER"
  if [[ $recorded == "$STACK_STARTED_AT" ]]; then
    suspended_notice
    die "cannot start: an earlier run left background work of the stack up.sh started at $recorded suspended"
  fi
  rm -f -- "$SUSPENDED_MARKER" || die "cannot remove the stale $SUSPENDED_MARKER"
  printf 'test-all: cleared a stale suspension marker of an earlier stack (startedAt %s)\n' "${recorded:-none}" >&2
}

# finish_run <exit code> <cause> <reason for the begun stage> <reason for later stages>: once only, stops the running
# stage, records each unrecorded stage (the begun one fail, the rest not-run), assembles the report unless an assembly
# already rewrote it, and prints the recovery notice and the closing line. Failures are reported and passed over.
finish_run() {
  local code=$1 cause=$2 why=$3 later=$4 n summary report="; no report written"
  [[ -z $FINISHED ]] || return 0
  FINISHED=1
  set +e +m
  stop_stage
  for ((n = NEXT_STAGE; n < ${#STAGE_FUNCS[@]}; n++)); do
    if [[ $n == "$CURRENT_STAGE" ]]; then
      printf '%s\n' "$why" >>"$(meta_file "$n" reasons)"
      (record_stage "$n" fail "$CURRENT_STARTED" "$(now_iso)") && printf 'stage %s: fail (%s)\n' "$n" "$why" >&2
    else
      (record_without_run "$n" not-run "$later")
    fi
  done
  if [[ -z $REPORT_WRITTEN ]]; then
    printf 'test-all: assembling the test-all report\n' >&2
    if summary="$(harness_run report:test-all </dev/null)"; then
      REPORT_WRITTEN=1
      printf '%s\n' "$summary"
    else
      printf 'opt2: report:test-all failed: %s\n' "$summary" >&2
      printf 'test-all: this run did not rewrite %s or %s; any report they hold is an earlier run'\''s\n' \
        "$REPORTS_DIR/test-all.json" "$REPORTS_DIR/test-all.md" >&2
    fi
  fi
  if [[ -n $REPORT_WRITTEN ]]; then report="; see $REPORTS_DIR/test-all.md"; fi
  suspended_notice
  printf 'test-all: exit %s (%s)%s. The stack stays up; harness/repro/down.sh stops it.\n' "$code" "$cause" "$report" >&2
}

# Ends an interrupted run: the running stage fails naming the signal and later stages are not-run; exits 1.
stop_interrupted() {
  finish_run 1 "SIG$CAUGHT_SIGNAL" "interrupted by SIG$CAUGHT_SIGNAL" \
    "stage ${CURRENT_STAGE:-$NEXT_STAGE} interrupted"
  exit 1
}

# on_signal <name>: TERM, INT and HUP trap. Acts at once while a stage runs or after the final assembly returned;
# otherwise once the record or assembly in progress is done. Ignored while the run is finishing.
# shellcheck disable=SC2329 # run by trap
on_signal() {
  [[ -z $FINISHED ]] || return 0
  if [[ -z $CAUGHT_SIGNAL ]]; then
    CAUGHT_SIGNAL=$1
    printf 'test-all: SIG%s received; stopping the run\n' "$1" >&2
  fi
  if [[ -n $CURRENT_PGID || -n $REPORT_ATTEMPTED ]]; then stop_interrupted; fi
}

# EXIT trap: after an unexpected failing exit, records the unrecorded stages and writes the report; keeps the status.
# shellcheck disable=SC2329 # run by trap
on_exit() {
  local rc=$? at
  set +e
  if [[ -n $FINISHED ]] || ((rc == 0)); then return 0; fi
  at=${CURRENT_STAGE:-$NEXT_STAGE}
  if [[ -n $CAUGHT_SIGNAL ]]; then
    finish_run "$rc" "SIG$CAUGHT_SIGNAL" "interrupted by SIG$CAUGHT_SIGNAL" "stage $at interrupted"
  else
    finish_run "$rc" "unexpected exit" "test-all.sh exited $rc before the stage was recorded" \
      "test-all.sh exited $rc at stage $at"
  fi
}

# package_slug <dir>: packageSlug of harness/src/reporting/speed.ts for a POSIX path, its non-empty segments joined by `-`.
package_slug() {
  local part
  local -a parts=() kept=()
  IFS=/ read -r -a parts <<<"$1"
  for part in "${parts[@]}"; do
    if [[ -n $part ]]; then kept+=("$part"); fi
  done
  (
    IFS=-
    printf '%s\n' "${kept[*]}"
  )
}

# run_package_tests <dir>: npm test in the package with the vitest JSON result at vitestResultPath(<dir>).
run_package_tests() {
  local pkg=$1 result status=0 key
  local -a unset_args=()
  for key in "${PACKAGE_TEST_UNSET[@]}"; do unset_args+=(-u "$key"); done
  result="$VITEST_DIR/$(package_slug "$pkg").json"
  rm -f -- "$result"
  run_step "npm test in $pkg" env "${unset_args[@]}" npm --prefix "$REPO/$pkg" run test -- --reporter=default \
    --reporter=json "--outputFile.json=$result" || status=$?
  note_package "$pkg" "$status"
  note_evidence "$result"
  return "$status"
}

# run_e2e <suite>: one harness e2e suite, its vitest JSON kept per suite under test-all/e2e.
run_e2e() {
  local suite=$1 result status=0
  result="$E2E_DIR/$(package_slug "$suite").json"
  rm -f -- "$result"
  run_step "test:e2e $suite" harness_run test:e2e -- "$suite" "--outputFile.json=$result" || status=$?
  note_evidence "$result"
  return "$status"
}

# Prints, in FAULT_NAMES order, the faults of the built migration package that reconcile afterwards.
reconciling_faults() {
  # shellcheck disable=SC2016 # JavaScript source
  node --input-type=module -e '
const { FAULT_NAMES, FAULT_SCRIPTS } = await import(process.argv[1]);
const names = FAULT_NAMES.filter((name) => FAULT_SCRIPTS[name]?.reconciles === true);
if (names.length === 0) throw new Error("no reconciling fault in FAULT_NAMES");
process.stdout.write(`${names.join("\n")}\n`);
' -- "$REPO/migration/dist/faults/index.js"
}

# Empties Mailpit and dies unless it then holds no message.
clear_mailpit() {
  local total
  curl -fsS --connect-timeout 10 --max-time 60 -o /dev/null -X DELETE "$MAILPIT_API_LOCAL/api/v1/messages" ||
    die "DELETE $MAILPIT_API_LOCAL/api/v1/messages failed"
  total="$(curl -fsS --connect-timeout 10 --max-time 60 "$MAILPIT_API_LOCAL/api/v1/messages?limit=1" | json_get - total)" ||
    die "cannot read the message count of $MAILPIT_API_LOCAL"
  [[ $total == 0 ]] || die "Mailpit still holds $total messages after DELETE /api/v1/messages"
  printf 'Mailpit empty\n'
}

# --- Stages ----------------------------------------------------------------------------------------------------

stage_pin() {
  local failures=0
  run_step "check:pin" harness_run check:pin || failures=1
  run_step "check:synthetic" harness_run check:synthetic || failures=1
  return "$failures"
}

stage_baseline() {
  local status=0
  run_step "baseline:run (official and diagnostic TestBox runners)" harness_run baseline:run || return 1
  run_step "baseline:compare" harness_run baseline:compare || status=$?
  note_evidence "$REPORTS_DIR/baseline.json" "$REPORTS_DIR/baseline.md" /tmp/masa-baseline.json "$OPT2_STATE_DIR/baseline"
  case $status in
    0) ;;
    3)
      clear_reasons
      note_reason "only the beanFeedSecurity timing spec differs, also after one re-run"
      set_result timing-variance
      ;;
    *) return 1 ;;
  esac
}

stage_platform() {
  local failures=0 pkg
  for pkg in "${PLATFORM_PACKAGES[@]}"; do run_package_tests "$pkg" || failures=1; done
  run_e2e isolation/platform-proof || failures=1
  note_evidence "$REPORTS_DIR/platform-proof.json"
  return "$failures"
}

stage_services() {
  local failures=0 pkg
  for pkg in "${SERVICE_PACKAGES[@]}"; do run_package_tests "$pkg" || failures=1; done
  return "$failures"
}

stage_migration() {
  local fault seq manifest store
  local -a faults=()
  run_step "reconcile after-backfill" "$MIGRATE" reconcile --point after-backfill || return 1
  note_evidence "$RECON_DIR/after-backfill.json"
  run_step "golden:workload through the gateway (v0001)" harness_run golden:workload || return 1
  run_step "feed" "$MIGRATE" feed || return 1
  run_step "reconcile after-feed-1" "$MIGRATE" reconcile --point after-feed-1 || return 1
  note_evidence "$RECON_DIR/after-feed-1.json"

  # projector-delay is a toggle without a reconciliation point; the read-after-write replay scenario sets it itself.
  run_step "reconciling faults of FAULT_NAMES" reconciling_faults || return 1
  mapfile -t faults <"$STEP_STDOUT"
  for fault in "${faults[@]}"; do
    run_step "fault $fault" "$MIGRATE" fault "$fault" || return 1
    note_evidence "$RECON_DIR/after-fault-$fault.json"
  done
  # Faults restart processes and rewrite their pids in up.json.
  run_step "stack recorded in up.json still up" require_stack || return 1

  run_step "snapshot Sk" "$MIGRATE" snapshot --kind checkpoint || return 1
  if ! seq="$(json_get "$STEP_STDOUT" seq)"; then
    note_reason "opt2-migrate snapshot reported no seq"
    return 1
  fi
  manifest="$(json_get "$STEP_STDOUT" manifestComplete 2>/dev/null)" || manifest=false
  store="$(json_get "$STEP_STDOUT" fileStore.status 2>/dev/null)" || store=""
  if [[ $manifest != true && $store != unsupported ]]; then
    run_step "file manifest of S$seq" "$MIGRATE" files manifest --snapshot "$seq" || return 1
  fi
  # Written first: a failed or interrupted drain-and-suspend can leave part of the background work suspended.
  if ! printf '%s\n' "$STACK_STARTED_AT" >"$SUSPENDED_MARKER"; then
    rm -f -- "$SUSPENDED_MARKER" || true
    note_reason "cannot write $SUSPENDED_MARKER, so drain-and-suspend did not run"
    return 1
  fi
  run_step "drain and suspend background work" "$OPT2_OPS" drain-and-suspend || return 1
  run_step "checkpoint Ck at S$seq" checkpoint_take "$seq" || return 1
  note_evidence "$RECON_DIR/summary.md" "$CK_DIR/ck.json"
}

stage_capture() {
  local failures=0
  run_step "empty Mailpit" clear_mailpit || return 1
  run_step "golden:capture against legacy directly ($LEGACY_ORIGIN)" harness_run golden:capture || failures=1
  # Browser flows are captured by the interaction suite, not golden:capture, and need v0001 like the other captures.
  OPT2_UI_PHASE=capture run_e2e ui/interactions || failures=1
  note_evidence "$REPO/harness/golden/sets"
  # Reset even after a failed capture, so the stack is left at Ck with its background work resumed.
  run_step "reset legacy and target to Ck" checkpoint_restore || return 1
  run_step "verify Ck" checkpoint_verify || return 1
  note_evidence "$CK_DIR/verify"
  run_step "resume background work" "$OPT2_OPS" resume || return 1
  if ! rm -f -- "$SUSPENDED_MARKER"; then
    note_reason "background work resumed, but $SUSPENDED_MARKER cannot be removed"
    return 1
  fi
  return "$failures"
}

stage_cutover() {
  local failures=0
  # GS-ID-09 opens its session under v0001 and resumes it after the transition, proving session adoption across it.
  run_step "GS-ID-09 before the transition" harness_run golden:replay -- --only GS-ID-09 --phase pre-transition ||
    failures=1
  run_step "transition to v0002" "$MIGRATE" transition --to v0002 || return 1
  note_evidence "$REPORTS_DIR/transitions.json"
  run_step "GS-ID-09 after the transition" harness_run golden:replay -- --only GS-ID-09 --phase resume || failures=1
  run_step "reconcile post-cutover" "$MIGRATE" reconcile --point post-cutover || failures=1
  note_evidence "$RECON_DIR/post-cutover.json"
  return "$failures"
}

stage_equivalence() {
  local failures=0 suite
  run_step "golden:replay through the gateway (v0002)" harness_run golden:replay || failures=1
  # golden:compare reads the interaction suite's browser replay records, so the suite runs before it.
  OPT2_UI_PHASE=replay run_e2e ui/interactions || failures=1
  run_step "golden:compare" harness_run golden:compare || failures=1
  run_step "golden:coverage" harness_run golden:coverage || failures=1
  note_evidence "$REPORTS_DIR/parity.json" "$REPORTS_DIR/parity.md" "$REPORTS_DIR/exceptions-list.md"
  for suite in "${E2E_SUITES[@]}"; do run_e2e "$suite" || failures=1; done
  run_step "security:scan" harness_run security:scan || failures=1
  note_evidence "$OPT2_STATE_DIR/security/summary.json"
  # The performance suite reads min_instance_count from the terraform-plan.json that plan.sh refreshes.
  if command -v terraform >/dev/null 2>&1; then
    run_step "infra/terraform/plan.sh (fmt, validate, plan)" "$REPO/infra/terraform/plan.sh" || failures=1
    note_evidence "$REPORTS_DIR/terraform-plan.json"
  else
    printf 'stage %s: infra/terraform/plan.sh skipped: terraform is not on PATH\n' "$STAGE_N" >&2
    note_reason "terraform is not on PATH, so infra/terraform/plan.sh did not run"
    note_unmet "Infrastructure: terraform fmt, validate and plan" "terraform is not on PATH"
  fi
  # The performance suite flags long windows from the windows.json that window report writes from migration.write_window.
  run_step "window report" "$MIGRATE" window report || failures=1
  run_e2e performance/performance || failures=1
  run_step "report:isolation" harness_run report:isolation || failures=1
  run_step "report:events" harness_run report:events || failures=1
  note_evidence "$REPORTS_DIR/isolation.json" "$REPORTS_DIR/events.json" "$REPORTS_DIR/observability.json"
  ((failures == 0)) || return 1
  if [[ -s $(meta_file "$STAGE_N" unmet) ]]; then set_result unmet; fi
}

stage_rollback() {
  local failures=0
  run_step "rollback set R" "$MIGRATE" rollback-set || return 1
  # GS-ID-09 crosses the v0003 activation too, so its session survives the rollback's session-mode switch.
  run_step "GS-ID-09 before the transition" harness_run golden:replay -- --only GS-ID-09 --phase pre-transition ||
    failures=1
  if run_step "transition to v0003" "$MIGRATE" transition --to v0003; then
    note_evidence "$RECON_DIR/rollback-before.json"
    run_step "GS-ID-09 after the transition" harness_run golden:replay -- --rehearsal --only GS-ID-09 --phase resume ||
      failures=1
    if run_step "rebaseline the target copy" "$MIGRATE" rollback rebaseline; then
      run_step "golden:replay of the rehearsal scenarios (v0003)" harness_run golden:replay -- --rehearsal || failures=1
      run_step "feed" "$MIGRATE" feed || failures=1
      run_step "reconcile rollback-after" "$MIGRATE" reconcile --point rollback-after || failures=1
      note_evidence "$RECON_DIR/rollback-after.json"
      run_step "golden:compare with the rehearsal" harness_run golden:compare || failures=1
    else
      failures=1
    fi
  else
    failures=1
  fi
  run_step "rollback report" "$MIGRATE" rollback report || failures=1
  note_evidence "$REPORTS_DIR/rollback-rehearsal.md" "$REPORTS_DIR/parity.json"
  return "$failures"
}

stage_reports() {
  local failures=0 file
  run_step "window report" "$MIGRATE" window report || failures=1
  run_step "report:speed" harness_run report:speed || failures=1
  run_step "check:reviewability" harness_run check:reviewability || failures=1
  run_step "check:deck --render" harness_run check:deck -- --render || failures=1
  for file in windows.json transitions.json; do
    run_step "$file of the migration service" json_get "$REPORTS_DIR/$file" status || failures=1
  done
  note_evidence "$REPORTS_DIR/speed.json" "$REPORTS_DIR/reviewability.json" "$REPORTS_DIR/windows.json" \
    "$REPORTS_DIR/transitions.json" "$REPO/opt2/executive-summary/index.html"
  return "$failures"
}

# --- Preconditions ---------------------------------------------------------------------------------------------

# The per-command flock ends with this shell; the run lock stays with the stack up.sh recorded.
lock_acquire test-all
[[ -x $REPO/harness/node_modules/.bin/tsx ]] ||
  die "the harness package is not built ($REPO/harness/node_modules/.bin/tsx is missing):" \
    "run harness/repro/up.sh, which builds every package, or npm ci in harness/"
require_stack
# The Masa settings up.sh adopted; the stack values up.json recorded still win.
adopt_captured_server_env
load_stack_env
export MURA_ADMIN_USERNAME="${MURA_ADMIN_USERNAME:-admin}"
require_env PG_USER PG_PASSWORD MURA_ADMIN_PASSWORD MASA_TEST_EDITOR_PASSWORD
require_cmd node npm curl box psql pg_dump pg_restore
# Validates fixtures.json and OPT2_REPORTS_DIR as report assembly uses them, before any stage runs.
INPUT_CHECK="$(harness_run report:test-all -- check </dev/null)" ||
  die "cannot start: report:test-all check rejected $FIXTURES_FILE or $REPORTS_DIR: $INPUT_CHECK"
FIXTURES_AVAILABLE="$(printf '%s\n' "$INPUT_CHECK" | json_get - fixtures.available)" ||
  die "report:test-all check printed no fixture status: $INPUT_CHECK"
[[ $FIXTURES_AVAILABLE == true ]] || FIXTURES_AVAILABLE=false
MIGRATION_SKIP_REASON="$(migration_skip_reason)"
check_suspended

ensure_state_dirs
mkdir -p -- "$TA_DIR"
chmod 0700 -- "$TA_DIR"
rm -rf -- "${RUN_DIR:?}" "${VITEST_DIR:?}" "${E2E_DIR:?}"
mkdir -m 0700 -- "$RUN_DIR" "$VITEST_DIR" "$E2E_DIR"
printf 'test-all: stack of %s, legacy %s, fixtures available=%s; stage output under %s\n' "$REPO" "$LEGACY_ORIGIN" \
  "$FIXTURES_AVAILABLE" "$TA_DIR" >&2

# --- Stages 0-9 ------------------------------------------------------------------------------------------------

trap 'on_signal TERM' TERM
trap 'on_signal INT' INT
trap 'on_signal HUP' HUP
trap on_exit EXIT

STOPPED_AT=""
for n in "${!STAGE_FUNCS[@]}"; do
  if [[ -n $CAUGHT_SIGNAL ]]; then stop_interrupted; fi
  if [[ -n $STOPPED_AT ]]; then
    record_without_run "$n" not-run "stage $STOPPED_AT failed"
  elif [[ -n $MIGRATION_SKIP_REASON ]] && ((n >= 4 && n <= 8)); then
    if ((n == 4)); then
      record_without_run "$n" skipped "$MIGRATION_SKIP_REASON"
    else
      record_without_run "$n" not-run "migration stages stop: $MIGRATION_SKIP_REASON"
    fi
  elif ! run_stage "$n" "${STAGE_FUNCS[n]}"; then
    STOPPED_AT=$n
  fi
  NEXT_STAGE=$((n + 1))
done

# --- Report ----------------------------------------------------------------------------------------------------

if [[ -n $CAUGHT_SIGNAL ]]; then stop_interrupted; fi
printf 'test-all: assembling the test-all report\n' >&2
report_rc=0
summary="$(harness_run report:test-all </dev/null)" || report_rc=$?
# A signal caught during assembly waits until REPORT_WRITTEN tells finish_run whether to assemble again.
if ((report_rc == 0)); then
  REPORT_WRITTEN=1
  printf '%s\n' "$summary"
fi
REPORT_ATTEMPTED=1
if [[ -n $CAUGHT_SIGNAL ]]; then stop_interrupted; fi
((report_rc == 0)) || die "report:test-all failed: $summary"
code="$(printf '%s\n' "$summary" | json_get - exitCode)" || die "report:test-all printed no exitCode: $summary"
[[ $code =~ ^[012]$ ]] || die "report:test-all reported exit code '$code'"
FINISHED=1
suspended_notice
printf 'test-all: exit %s; see %s/test-all.md. The stack stays up; harness/repro/down.sh stops it.\n' "$code" \
  "$REPORTS_DIR" >&2
exit "$code"
