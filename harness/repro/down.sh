#!/usr/bin/env bash
# Stops the OPT-2 stack up.sh recorded and restores legacy Masa from the pristine captures, then releases the run lock.
set -euo pipefail

# Prints the one-line usage to stderr and exits 2.
usage_error() {
  printf 'usage: harness/repro/down.sh [-h|--help]\n' >&2
  exit 2
}

case $# in
  0) ;;
  1)
    case $1 in
      -h | --help)
        cat <<'EOF'
usage: harness/repro/down.sh

Stops every target process recorded in ${OPT2_STATE_DIR:-$HOME/.opt2/state}/up.json and the tooling up.sh started,
stops ColdFusion, restores the legacy database and file store from the pristine baseline, re-imports the original
scheduled tasks, restores the /muraWRM mapping, restarts the original legacy server without the OPT-2 start variables
and releases the run lock. Takes no arguments; run again after a completed teardown, it reports nothing running.

Environment (* = secret):
  OPT2_STATE_DIR OPT2_PRISTINE_DIR   the directories up.sh used (default $HOME/.opt2/state, $HOME/.opt2/pristine)
  PORT or OPT2_LEGACY_PORT           legacy ColdFusion port, when up.sh captured a legacy server (OPT2_LEGACY_PORT wins)
  MURA_DBHOST MURA_DBUSERNAME MURA_DBPASSWORD* MURA_DATABASE
                                     legacy SQL Server database, when a pristine baseline exists (MURA_DBPORT default 1433)
  PG_HOST PG_PORT                    PostgreSQL, when up.sh started it
  OPT2_PG_STOP_CMD                   stops that PostgreSQL (default pg_ctlcluster 16 main stop)
  OPT2_MSSQL_TRUST_SERVER_CERT and OPT2_LEGACY_START_TIMEOUT_S apply as for up.sh; harness/README.md describes each.

Example, in the environment up.sh ran with:
  harness/repro/down.sh

Exit: 0 stopped and restored (or nothing running), 1 failure, 2 usage error.
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
# shellcheck source=SCRIPTDIR/lib/pristine.sh
source "$LIB_DIR/pristine.sh"

UP_FILE="$OPT2_STATE_DIR/up.json"
TOOLING_FILE="$OPT2_STATE_DIR/tooling.json"
CAPTURE_FILE="$OPT2_PRISTINE_DIR/server-capture.json"
PRISTINE_FILE="$OPT2_PRISTINE_DIR/pristine.json"
NATIVE_CFCONFIG_FILE="$OPT2_PRISTINE_DIR/native-tasks.cfconfig.json"
TASKS_EXPORT="$OPT2_STATE_DIR/commandbox/down-tasks.json"
SURVEY_TASK_PREFIX=opt2-survey-
STOPPED_AT="$(date -u +%Y%m%dT%H%M%SZ)"

SUMMARY=()
FAILED=()
STEP_STATUS=0

# --- Target side -----------------------------------------------------------------------------------------------

# Prints `<name>\t<pid>\t<cwd>` per process recorded in up.json, in reverse start order (gateway first).
recorded_processes() {
  local cli=""
  [[ -f $UP_FILE ]] || return 0
  # The CLI's one-line JSON answer carries any failure reason; its stack trace on stderr is left out.
  if [[ -x $REPO/harness/node_modules/.bin/tsx ]] &&
    ! cli="$(harness_run repro:up-state -- read --field processes 2>/dev/null)"; then
    printf 'opt2: up-state.ts cannot read %s (%s); reading its process entries directly\n' "$UP_FILE" "$cli" >&2
    cli=""
  fi
  # shellcheck disable=SC2016 # JavaScript source
  node -e '
const fs = require("fs");
const [file, cli, ...order] = process.argv.slice(1);
const parse = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
let processes = cli.split("\n").reverse().map(parse).find((doc) => doc?.ok === true)?.value;
if (processes === undefined) processes = parse(fs.readFileSync(file, "utf8"))?.processes;
if (processes === null || typeof processes !== "object" || Array.isArray(processes)) process.exit(0);
const rank = (name) => (order.includes(name) ? order.length - 1 - order.indexOf(name) : order.length);
const rows = Object.entries(processes)
  .filter(([name, entry]) => Number.isInteger(entry?.pid) && entry.pid > 1 && typeof entry.cwd === "string" &&
    !/[\t\n]/.test(name + entry.cwd))
  .sort(([a], [b]) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
  .map(([name, entry]) => `${name}\t${entry.pid}\t${entry.cwd}\n`);
process.stdout.write(rows.join(""));
' -- "$UP_FILE" "$cli" "${TARGET_START_ORDER[@]}"
}

# Stops every recorded target process whose pid still runs in its recorded directory; dies when one survives.
stop_target_processes() {
  local text name pid cwd actual
  local -a stopped=() gone=() foreign=()
  text="$(recorded_processes)" || die "cannot read the processes recorded in $UP_FILE"
  while IFS=$'\t' read -r name pid cwd; do
    [[ -n $name ]] || continue
    # A recorded pid the kernel has since reused runs elsewhere, and that process group must not be signalled.
    if ! actual="$(readlink -e -- "/proc/$pid/cwd" 2>/dev/null)"; then
      gone+=("$name")
    elif [[ $actual != "$(realpath -m -- "$cwd")" ]]; then
      printf 'opt2: pid %s recorded for %s now runs in %s, not %s; left running\n' "$pid" "$name" "$actual" "$cwd" >&2
      foreign+=("$name")
    else
      printf 'opt2: stopping %s (pid %s)\n' "$name" "$pid" >&2
      stop_process "$pid"
      stopped+=("$name (pid $pid)")
    fi
  done <<<"$text"
  SUMMARY+=("target processes: stopped $(join_or_none "${stopped[@]}"); already gone $(join_or_none "${gone[@]}")")
  if ((${#foreign[@]} > 0)); then SUMMARY+=("target processes left running, pid reused: ${foreign[*]}"); fi
}

# Prints the names tooling.json records as started by up.sh, SQL Server excepted since it is never stopped.
started_tooling() {
  [[ -f $TOOLING_FILE ]] || return 0
  # shellcheck disable=SC2016 # JavaScript source
  node -e '
const doc = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
for (const [name, entry] of Object.entries(doc)) {
  if (entry?.state === "started" && name !== "sqlserver") process.stdout.write(`${name}\n`);
}
' -- "$TOOLING_FILE"
}

# Prints the arguments joined by `, `, or `none`.
join_or_none() {
  local out item
  if (($# == 0)); then
    printf 'none'
    return 0
  fi
  out=$1
  shift
  for item in "$@"; do out+=", $item"; done
  printf '%s' "$out"
}

# --- Legacy side -----------------------------------------------------------------------------------------------

# run_step <label> <function>: runs a restore step under errexit in a subshell, sets STEP_STATUS, and adds its stdout
# lines to SUMMARY or <label> to FAILED.
run_step() {
  local label=$1 out line
  out="$(mktemp -- "$OPT2_STATE_DIR/.down-step.XXXXXX")" || die "cannot create a temp file in $OPT2_STATE_DIR"
  set +e
  (
    set -e
    "${@:2}"
  ) >"$out"
  STEP_STATUS=$?
  set -e
  if ((STEP_STATUS == 0)); then
    while IFS= read -r line; do
      if [[ -n $line ]]; then SUMMARY+=("$line"); fi
    done <"$out"
  else
    FAILED+=("$label")
    SUMMARY+=("$label: FAILED (exit $STEP_STATUS, message above)")
  fi
  rm -f -- "$out"
}

# Prints a field of server-capture.json, empty when absent or null.
capture_value() {
  local value
  value="$(json_get "$CAPTURE_FILE" "$1" 2>/dev/null)" || value=""
  if [[ $value == null ]]; then value=""; fi
  printf '%s\n' "$value"
}

# Prints `<status> <port>` of CommandBox server <name>, status lower-cased; nothing when no such server is registered.
cf_server_state() {
  local info found status port
  # `box server info` exits 0 with no output for an unknown name, so the reported name decides.
  info="$(box server info name="$1" --json </dev/null 2>/dev/null)" || return 0
  found="$(printf '%s' "$info" | json_get - name 2>/dev/null)" || return 0
  [[ ${found,,} == "${1,,}" ]] || return 0
  status="$(printf '%s' "$info" | json_get - status 2>/dev/null)" || status=unknown
  port="$(printf '%s' "$info" | json_get - port 2>/dev/null)" || port=""
  printf '%s %s\n' "${status,,}" "$port"
}

# True when something listens on legacy's port.
legacy_listening() {
  ! (assert_port_free "$LEGACY_PORT") 2>/dev/null
}

# Stops opt2-legacy, then the captured original server if it still listens on legacy's port; waits for the port.
stop_coldfusion() {
  local name state original
  local -a stopped=()
  original="$(capture_value name)"
  for name in "$LEGACY_SERVER_NAME" "$original"; do
    if [[ -z $name ]] || ! legacy_listening; then continue; fi
    state="$(cf_server_state "$name")"
    if [[ -z $state || $state == stopped* ]]; then continue; fi
    if [[ $name != "$LEGACY_SERVER_NAME" && ${state#* } != "$LEGACY_PORT" ]]; then continue; fi
    box server stop name="$name" </dev/null >&2 || die "box server stop name=$name failed"
    stopped+=("$name")
  done
  wait_port_closed "$LEGACY_PORT" 120
  printf 'ColdFusion: stopped %s; port %s closed\n' "$(join_or_none "${stopped[@]}")" "$LEGACY_PORT"
}

# Restores the legacy database and file store from the pristine baseline, when one was taken.
restore_pristine() {
  local result backup removed
  if [[ ! -f $PRISTINE_FILE ]]; then
    printf 'database and file store: not restored, no pristine baseline in %s (never taken)\n' "$OPT2_PRISTINE_DIR"
    return 0
  fi
  result="$(pristine_restore)"
  backup="$(printf '%s\n' "$result" | json_get - backupPath)"
  removed="$(printf '%s\n' "$result" | json_get - removedSiteDirs)"
  removed=${removed#[}
  removed=${removed%]}
  removed=${removed//\"/}
  printf 'database and file store: %s and the file store restored from %s; site directories removed: %s\n' \
    "$MURA_DATABASE" "$backup" "${removed:-none}"
}

# Re-imports the captured scheduled tasks into the original server, then deletes any opt2-survey-* task left over.
restore_tasks() {
  local target leftover
  local -a captured=()
  if [[ ! -f $NATIVE_CFCONFIG_FILE ]]; then
    printf 'scheduled tasks: left as they are, none captured (ColdFusion was not running when up.sh first ran)\n'
    return 0
  fi
  target="$(capture_value cfconfigTarget)"
  [[ -n $target ]] || die "$CAPTURE_FILE has no cfconfigTarget"
  cfconfig_import "$NATIVE_CFCONFIG_FILE" "$target" >&2 || die "cannot import $NATIVE_CFCONFIG_FILE into $target"
  # The export holds task credentials decrypted.
  trap 'rm -f -- "$TASKS_EXPORT"' EXIT
  rm -f -- "$TASKS_EXPORT"
  cfconfig_export "$TASKS_EXPORT" "$target" >&2 || die "cannot export the scheduled tasks of $target"
  leftover="$(node "$LIB_DIR/cfconfig-tasks.mjs" names --in "$TASKS_EXPORT" --prefix "$SURVEY_TASK_PREFIX")"
  if [[ -n $leftover ]]; then
    printf 'opt2: deleting leftover tasks: %s\n' "${leftover//$'\n'/, }" >&2
    node "$LIB_DIR/cfconfig-tasks.mjs" drop-prefix --prefix "$SURVEY_TASK_PREFIX" \
      --in "$TASKS_EXPORT" --out "$TASKS_EXPORT"
    cfconfig_import "$TASKS_EXPORT" "$target" >&2 ||
      die "cannot import the scheduled tasks of $target without $SURVEY_TASK_PREFIX*"
    rm -f -- "$TASKS_EXPORT"
    cfconfig_export "$TASKS_EXPORT" "$target" >&2 || die "cannot export the scheduled tasks of $target"
    leftover="$(node "$LIB_DIR/cfconfig-tasks.mjs" names --in "$TASKS_EXPORT" --prefix "$SURVEY_TASK_PREFIX")"
    [[ -z $leftover ]] || die "$SURVEY_TASK_PREFIX* tasks survive the re-import into $target: ${leftover//$'\n'/, }"
  fi
  mapfile -t captured < <(node "$LIB_DIR/cfconfig-tasks.mjs" names --in "$NATIVE_CFCONFIG_FILE")
  printf 'scheduled tasks: the %d captured task(s) re-imported into %s\n' "${#captured[@]}" "$target"
}

# Deletes the server-level /muraWRM mapping from the server legacy-start.sh saved it to, or restores a pre-existing one.
restore_mapping() {
  local lines original
  local -a to=()
  lines="$(cfconfig_target to)"
  mapfile -t to <<<"$lines"
  to[0]="to=${to[0]}"
  original="$(capture_value muraWRMMapping)"
  if [[ -n $original ]]; then
    box cfconfig cfmapping save virtual=/muraWRM physical="$original" "${to[@]}" </dev/null >&2 ||
      die "box cfconfig cfmapping save /muraWRM failed"
    printf '/muraWRM mapping: restored to its original %s on %s\n' "$original" "${to[0]#to=}"
  else
    box cfconfig cfmapping delete virtual=/muraWRM "${to[@]}" </dev/null >&2 ||
      die "box cfconfig cfmapping delete /muraWRM failed"
    printf '/muraWRM mapping: removed from %s\n' "${to[0]#to=}"
  fi
}

# Starts the captured original server without the OPT-2 start variables, when it was running at capture.
restart_original() {
  local name summary
  name="$(capture_value name)"
  if [[ $(capture_value wasRunning) != true ]]; then
    printf 'original legacy server: not started, %s was not running when up.sh captured it\n' "${name:-(none)}"
    return 0
  fi
  summary="$("$LIB_DIR/legacy-start.sh" --original)"
  printf '%s\n' "$summary" >&2
  printf 'original legacy server: %s started on port %s with its own settings and ping\n' "$name" "$LEGACY_PORT"
}

# Stops ColdFusion and runs every restore step; the original server starts only on a restored database.
restore_legacy() {
  if [[ ! -f $CAPTURE_FILE ]]; then
    SUMMARY+=("legacy: untouched, no legacy server was captured in $CAPTURE_FILE")
    return 0
  fi
  # No server.json in this directory, so CommandBox resolves servers by name alone.
  cd -- "$OPT2_STATE_DIR"
  log_step 3 "stop ColdFusion"
  run_step coldfusion-stop stop_coldfusion
  if ((STEP_STATUS != 0)); then
    SUMMARY+=("legacy: not restored, ColdFusion still holds port $LEGACY_PORT")
    return 0
  fi
  log_step 4 "restore the legacy database and file store"
  run_step database-restore restore_pristine
  local restored=$STEP_STATUS
  log_step 5 "re-import the original scheduled tasks"
  run_step scheduled-tasks restore_tasks
  # While ColdFusion is stopped, so the original server starts with the restored mapping.
  log_step 6 "restore the /muraWRM mapping"
  run_step muraWRM-mapping restore_mapping
  if ((restored != 0)); then
    SUMMARY+=("original legacy server: not started, its database was not restored")
    return 0
  fi
  # The target stack is already stopped, so nothing writes legacy once the original server runs.
  log_step 7 "start the original legacy server"
  run_step original-start restart_original
}

# --- Main ------------------------------------------------------------------------------------------------------

lock_acquire down

if ! (lock_assert_mine) 2>/dev/null && [[ ! -e $UP_FILE && ! -e $TOOLING_FILE ]]; then
  printf 'OPT-2 stack down: nothing running for %s (no run lock, up.json or tooling.json); legacy left as it is.\n' \
    "$REPO"
  exit 0
fi

mapfile -t TOOLS < <(started_tooling)
require_cmd node readlink realpath
if [[ " ${TOOLS[*]} " == *" postgres "* ]]; then require_env PG_HOST PG_PORT; fi
if [[ -f $CAPTURE_FILE ]]; then
  require_cmd box curl setsid
  [[ $LEGACY_PORT =~ ^[1-9][0-9]*$ ]] ||
    die "legacy port '${LEGACY_PORT}' unknown or invalid: set PORT (or OPT2_LEGACY_PORT) as for up.sh"
  if [[ -f $PRISTINE_FILE ]]; then require_env MURA_DBHOST MURA_DBUSERNAME MURA_DBPASSWORD MURA_DATABASE; fi
fi
ensure_state_dirs

log_step 1 "stop the target processes"
stop_target_processes

log_step 2 "stop the tooling up.sh started"
stop_started_tooling
SUMMARY+=("tooling: stopped $(join_or_none "${TOOLS[@]}"); SQL Server and Mailpit left running")

restore_legacy

if [[ -f $UP_FILE ]]; then
  mv -f -- "$UP_FILE" "$UP_FILE.stopped-$STOPPED_AT" || die "cannot rename $UP_FILE"
  SUMMARY+=("state: up.json kept as $UP_FILE.stopped-$STOPPED_AT")
fi
rm -f -- "$TOOLING_FILE"

printf 'OPT-2 stack down for %s:\n' "$REPO"
printf '  %s\n' "${SUMMARY[@]}"
if ((${#FAILED[@]} > 0)); then
  # The kept lock makes the next down.sh redo the restore rather than report nothing running.
  printf 'opt2: restore steps failed: %s; run lock kept, so rerunning harness/repro/down.sh retries them\n' \
    "$(join_or_none "${FAILED[@]}")" >&2
  exit 1
fi
lock_release
printf '  run lock: released\n'
