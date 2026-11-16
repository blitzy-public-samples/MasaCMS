#!/usr/bin/env bash
# Stops the OPT-2 stack up.sh recorded, drops its snapshot databases, schemas and roles, and restores legacy Masa from
# the pristine captures, then releases the run lock.
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

Stops every target process recorded in ${OPT2_STATE_DIR:-$HOME/.opt2/state}/up.json. Drops the snapshot databases
${MURA_DATABASE}_opt2_snap_<n> with their snap-<n>.bak backups, then every OPT-2 PostgreSQL schema with its three
roles (opt2-db teardown --target local). A PostgreSQL that does not answer fails that drop when tooling.json records
one for this stack, and is only reported when it records none. Then stops the tooling up.sh started, stops
ColdFusion, restores the legacy database and file store from the pristine baseline, re-imports the original
scheduled tasks, restores the /muraWRM mapping, restarts the original legacy server without the OPT-2 start
variables, removes this checkout's opt2-legacy CommandBox registration (registry entry only, server files kept) and
releases the run lock. A failed step keeps the lock, and a failed schema drop keeps PostgreSQL's tooling.json entry
and does not stop it, so a rerun retries them. Takes no arguments; run again after a completed teardown, it reports
nothing running.

Environment (* = secret):
  OPT2_STATE_DIR OPT2_PRISTINE_DIR   the directories up.sh used (default $HOME/.opt2/state, $HOME/.opt2/pristine)
  PORT or OPT2_LEGACY_PORT           legacy ColdFusion port, when up.sh captured a legacy server (OPT2_LEGACY_PORT wins)
  MURA_DBHOST MURA_DBUSERNAME MURA_DBPASSWORD* MURA_DATABASE
                                     legacy SQL Server database: its snapshot databases, and the restore when a
                                     pristine baseline exists (MURA_DBPORT default 1433)
  PG_HOST PG_PORT PG_USER PG_PASSWORD* PG_DATABASE
                                     PostgreSQL holding the OPT-2 schemas and roles, as for up.sh
  OPT2_PG_STOP_CMD                   stops a PostgreSQL up.sh started (default pg_ctlcluster 16 main stop)
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

# Prints `<name>\t<pid>\t<cwd>\t<start time>` per process recorded in up.json, in reverse start order (gateway first);
# the start time is empty when none is recorded.
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
  .map(([name, entry]) => {
    const start = typeof entry.startTime === "string" && /^\d+$/.test(entry.startTime) ? entry.startTime : "";
    return `${name}\t${entry.pid}\t${entry.cwd}\t${start}\n`;
  });
process.stdout.write(rows.join(""));
' -- "$UP_FILE" "$cli" "${TARGET_START_ORDER[@]}"
}

# Stops every recorded target process still running as this stack's, or the owned members of its exited session;
# dies, keeping up.json, tooling.json and the run lock, when a live recorded pid has no start time to verify.
stop_target_processes() {
  local text name pid start actual
  local -a stopped=() gone=() foreign=() unverified=() contract=()
  text="$(recorded_processes)" || die "cannot read the processes recorded in $UP_FILE"
  while IFS=$'\t' read -r name pid _ start; do
    [[ -n $name ]] || continue
    # process_env sets both, and every respawn of an up.json entry keeps its env.
    contract=("OPT2_SERVICE_NAME=$name" "OPT2_STATE_DIR=$OPT2_STATE_DIR")
    if ! _opt2_pid_alive "$pid"; then
      stop_process "$pid" "${contract[@]}"
      if ((STOPPED_PROCESS_COUNT > 0)); then
        stopped+=("$name (exited pid $pid: $STOPPED_PROCESS_COUNT orphaned member(s))")
      else
        gone+=("$name")
      fi
      continue
    fi
    # Only the recorded start time tells the launched process from a later one the kernel gave the same pid.
    actual="$(_opt2_proc_start_time "$pid")" || actual=""
    if [[ -z $start ]]; then
      printf 'opt2: pid %s recorded for %s cannot be verified (no start time recorded); left running\n' \
        "$pid" "$name" >&2
      unverified+=("$name (pid $pid)")
    elif [[ $actual != "$start" ]]; then
      printf 'opt2: pid %s recorded for %s is not the process up.sh started (start time %s, recorded %s); left running\n' \
        "$pid" "$name" "${actual:-unknown}" "$start" >&2
      foreign+=("$name")
    else
      printf 'opt2: stopping %s (pid %s)\n' "$name" "$pid" >&2
      stop_process "$pid" "${contract[@]}"
      stopped+=("$name (pid $pid)")
    fi
  done <<<"$text"
  if ((${#unverified[@]} > 0)); then
    die "no start time is recorded for $(join_or_none "${unverified[@]}") in $UP_FILE, so down.sh cannot tell it" \
      "from another process; up.json, tooling.json and the run lock are kept. Stop it by hand if it is that service," \
      "or remove its processes.<name> entry from up.json if it is not, then rerun harness/repro/down.sh"
  fi
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

# Prints the state tooling.json records for tool $1, nothing when it holds no entry for it; fails when unreadable.
tooling_state() {
  [[ -f $TOOLING_FILE ]] || return 0
  # shellcheck disable=SC2016 # JavaScript source
  node -e '
const [file, name] = process.argv.slice(1);
const doc = JSON.parse(require("fs").readFileSync(file, "utf8"));
if (doc === null || typeof doc !== "object" || Array.isArray(doc)) throw new Error(`${file} is not a JSON object`);
if (Object.hasOwn(doc, name)) process.stdout.write(String(doc[name]?.state));
' -- "$TOOLING_FILE" "$1"
}

# --- OPT-2 databases -------------------------------------------------------------------------------------------

# Prints the sequence of every <MURA_DATABASE>_opt2_snap_<n> database on the legacy server, in numeric order.
snapshot_seqs() {
  local prefix="${MURA_DATABASE}_opt2_snap_" like names name
  local -a seqs=()
  # The LIKE wildcards of the name match only themselves.
  like=${prefix//[[]/[[]}
  like=${like//[_]/[_]}
  like=${like//[%]/[%]}
  names="$(sqlcmd_legacy --db master -Q \
    "SET NOCOUNT ON; SELECT name FROM sys.databases WHERE name LIKE $(_pristine_sql_string "$like%");")" ||
    die "cannot list the snapshot databases of $MURA_DATABASE"
  while IFS= read -r name; do
    if [[ $name == "$prefix"* && ${name#"$prefix"} =~ ^[0-9]+$ ]]; then seqs+=("${name#"$prefix"}"); fi
  done <<<"$names"
  ((${#seqs[@]} > 0)) || return 0
  printf '%s\n' "${seqs[@]}" | sort -n
}

# Drops database $1 from the legacy server, when it exists, as migration's dropDatabaseSql does.
drop_database_direct() {
  local ident sql
  ident="$(_pristine_sql_name "$1")"
  sql="IF DB_ID($(_pristine_sql_string "$1")) IS NOT NULL BEGIN ALTER DATABASE $ident SET SINGLE_USER WITH ROLLBACK IMMEDIATE;"
  sql+=" DROP DATABASE $ident; END;"
  sqlcmd_legacy --db master -Q "$sql" >&2
}

# Drops every snapshot database of MURA_DATABASE through opt2-migrate, or directly where migration holds no record of
# it, and deletes every snapshot backup; prints one summary line.
drop_snapshots() {
  local dir="$OPT2_STATE_DIR/snapshots" text seq db answer reason file
  local -a seqs=() backups=() dropped=()
  require_env MURA_DBHOST MURA_DBUSERNAME MURA_DBPASSWORD MURA_DATABASE
  for file in "$dir"/snap-*.bak; do
    if [[ -f $file ]]; then backups+=("$file"); fi
  done
  text="$(snapshot_seqs)" || exit 1
  if [[ -n $text ]]; then mapfile -t seqs <<<"$text"; fi
  MIGRATE_ERR="$(mktemp -- "$OPT2_STATE_DIR/.down-migrate.XXXXXX")" || die "cannot create a temp file in $OPT2_STATE_DIR"
  trap 'rm -f -- "$MIGRATE_ERR"' EXIT
  for seq in "${seqs[@]}"; do
    db="${MURA_DATABASE}_opt2_snap_$seq"
    # Its one-line JSON answer carries the failure reason; the stack trace on stderr is kept out of the summary.
    if answer="$("$MIGRATE" snapshot drop --seq "$seq" 2>"$MIGRATE_ERR")"; then
      dropped+=("$db")
    else
      reason="$(printf '%s\n' "$answer" | json_get - error.message 2>/dev/null)" || reason="$(tail -n 1 -- "$MIGRATE_ERR")"
      printf 'opt2: opt2-migrate snapshot drop --seq %s: %s; dropping %s directly\n' "$seq" "${reason:-failed}" "$db" >&2
      dropped+=("$db (directly)")
    fi
    # A no-op once opt2-migrate dropped it.
    drop_database_direct "$db"
  done
  for file in "${backups[@]}"; do rm -f -- "$file"; done
  text="$(snapshot_seqs)" || exit 1
  [[ -z $text ]] || die "snapshot databases survive the drop: sequences ${text//$'\n'/, }"
  printf 'snapshots: dropped %s; backups deleted: %s\n' "$(join_or_none "${dropped[@]}")" \
    "$(join_or_none "${backups[@]##*/}")"
}

# Drops every OPT-2 schema and its roles through opt2-db teardown. A PostgreSQL that does not answer fails the step
# when tooling.json records one, since up.sh bootstraps only after recording it, and is only reported otherwise.
drop_target_schemas() {
  local cli="$REPO/migration/dist/db-bootstrap/cli.js" ready=0 recorded summary counts schemas roles absent
  require_env PG_HOST PG_PORT PG_USER PG_PASSWORD PG_DATABASE
  require_cmd pg_isready
  if [[ ! -f $cli ]]; then
    printf 'target schemas and roles: none dropped, %s is not built, so no bootstrap ran from this checkout\n' "$cli"
    return 0
  fi
  # Exit 2: no response to the connection attempt.
  pg_isready -q -h "$PG_HOST" -p "$PG_PORT" >/dev/null 2>&1 || ready=$?
  if ((ready == 2)); then
    recorded="$(tooling_state postgres)" || die "cannot read $TOOLING_FILE"
    [[ -z $recorded ]] || die "PostgreSQL does not answer on $PG_HOST:$PG_PORT, so the OPT-2 schemas and roles may" \
      "remain: start PostgreSQL and rerun harness/repro/down.sh"
    printf 'target schemas and roles: not dropped, PostgreSQL does not answer on %s:%s and no PostgreSQL was %s\n' \
      "$PG_HOST" "$PG_PORT" "recorded for this stack"
    return 0
  fi
  summary="$(OPT2_ENV=local "$OPT2_DB" teardown --target local)" ||
    die "opt2-db teardown --target local failed: $summary"
  # Prints `<schemas dropped> <roles dropped> <schemas absent>`.
  # shellcheck disable=SC2016 # JavaScript source
  counts="$(printf '%s\n' "$summary" | node -e '
const doc = JSON.parse(require("fs").readFileSync(0, "utf8").trim().split("\n").pop());
process.stdout.write(`${doc.schemas.dropped.length} ${doc.roles} ${doc.schemas.absent.length}`);
')" || die "opt2-db teardown printed no summary: $summary"
  read -r schemas roles absent <<<"$counts"
  printf 'target schemas and roles: dropped %s schema(s) and %s role(s) from %s:%s/%s; %s schema(s) already absent\n' \
    "$schemas" "$roles" "$PG_HOST" "$PG_PORT" "$PG_DATABASE" "$absent"
}

# Rewrites tooling.json to hold only the named entries.
keep_tooling_entries() {
  # shellcheck disable=SC2016 # JavaScript source
  node -e '
const fs = require("fs");
const [file, ...names] = process.argv.slice(1);
const doc = JSON.parse(fs.readFileSync(file, "utf8"));
const kept = Object.fromEntries(Object.entries(doc).filter(([name]) => names.includes(name)));
fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(kept, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(`${file}.tmp`, file);
' -- "$TOOLING_FILE" "$@"
}

# --- Legacy side -----------------------------------------------------------------------------------------------

# run_step <label> <function>: runs a teardown step under errexit in a subshell, sets STEP_STATUS, and adds its stdout
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
  local name state original record
  local -a stopped=()
  original="$(capture_value name)"
  for name in "$LEGACY_SERVER_NAME" "$original"; do
    if [[ -z $name ]] || ! legacy_listening; then continue; fi
    if [[ $name == "$LEGACY_SERVER_NAME" ]]; then
      record="$(legacy_registration)" || exit 1
      # A registration in another server home is never stopped.
      legacy_record_home_ours "$record" || continue
    fi
    state="$(cf_server_state "$name")"
    if [[ -z $state || $state == stopped* ]]; then continue; fi
    if [[ $name != "$LEGACY_SERVER_NAME" && ${state#* } != "$LEGACY_PORT" ]]; then continue; fi
    box server stop name="$name" </dev/null >&2 || die "box server stop name=$name failed"
    stopped+=("$name")
  done
  wait_port_closed "$LEGACY_PORT" 120
  printf 'ColdFusion: stopped %s; port %s closed\n' "$(join_or_none "${stopped[@]}")" "$LEGACY_PORT"
}

# Removes this checkout's opt2-legacy registry entry, keeping its server files, so the next checkout's up.sh can
# register its own; another checkout's registration is left in place.
unregister_legacy() {
  local record result
  record="$(legacy_registration)"
  if [[ -z $record ]]; then
    printf 'CommandBox server %s: not registered\n' "$LEGACY_SERVER_NAME"
  elif legacy_record_ours "$record"; then
    result="$(legacy_unregister "$(legacy_registration_field "$record" id)")"
    if [[ $result == removed ]]; then
      printf 'CommandBox server %s: registration removed (server files kept)\n' "$LEGACY_SERVER_NAME"
    else
      printf 'CommandBox server %s: not registered\n' "$LEGACY_SERVER_NAME"
    fi
  else
    printf "CommandBox server %s: registration of %s left in place (not this checkout's)\n" "$LEGACY_SERVER_NAME" \
      "$(legacy_registration_field "$record" webroot)"
  fi
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
  log_step 5 "stop ColdFusion"
  run_step coldfusion-stop stop_coldfusion
  if ((STEP_STATUS != 0)); then
    SUMMARY+=("legacy: not restored, ColdFusion still holds port $LEGACY_PORT")
    return 0
  fi
  log_step 6 "restore the legacy database and file store"
  run_step database-restore restore_pristine
  local restored=$STEP_STATUS
  log_step 7 "re-import the original scheduled tasks"
  run_step scheduled-tasks restore_tasks
  # While ColdFusion is stopped, so the original server starts with the restored mapping.
  log_step 8 "restore the /muraWRM mapping"
  run_step muraWRM-mapping restore_mapping
  if ((restored != 0)); then
    SUMMARY+=("original legacy server: not started, its database was not restored")
  else
    # The target stack is already stopped, so nothing writes legacy once the original server runs.
    log_step 9 "start the original legacy server"
    run_step original-start restart_original
  fi
  # Last, so the mapping restore and the original start still see the registration legacy-start.sh used.
  log_step 10 "remove this checkout's $LEGACY_SERVER_NAME registration, keeping its server files"
  run_step legacy-registration unregister_legacy
}

# --- Main ------------------------------------------------------------------------------------------------------

lock_acquire down

if ! (lock_assert_mine) 2>/dev/null && [[ ! -e $UP_FILE && ! -e $TOOLING_FILE ]]; then
  printf 'OPT-2 stack down: nothing running for %s (no run lock, up.json or tooling.json); legacy left as it is.\n' \
    "$REPO"
  exit 0
fi

mapfile -t TOOLS < <(started_tooling)
require_cmd node realpath ps
if [[ " ${TOOLS[*]} " == *" postgres "* ]]; then require_env PG_HOST PG_PORT; fi
if [[ -f $CAPTURE_FILE ]]; then
  require_cmd box curl setsid
  [[ $LEGACY_PORT =~ ^[1-9][0-9]*$ ]] ||
    die "legacy port '${LEGACY_PORT}' unknown or invalid: set PORT (or OPT2_LEGACY_PORT) as for up.sh"
  # The Masa settings up.sh adopted, so the restore addresses the database it baselined.
  adopt_captured_server_env
  if [[ -f $PRISTINE_FILE ]]; then require_env MURA_DBHOST MURA_DBUSERNAME MURA_DBPASSWORD MURA_DATABASE; fi
fi
ensure_state_dirs

log_step 1 "stop the target processes"
stop_target_processes

# While the tooling still runs: an up.sh-started PostgreSQL holds the snapshot records and the target schemas.
log_step 2 "drop the snapshot databases"
run_step snapshots drop_snapshots
log_step 3 "drop the target schemas and roles"
run_step target-schemas drop_target_schemas
# A failed drop keeps PostgreSQL's tooling.json entry, whatever its state, so the retry requires the drop again; an
# up.sh-started PostgreSQL is not stopped, so the retry finds it and then stops it.
KEPT_TOOLS=()
if ((STEP_STATUS != 0)) && [[ -n $(tooling_state postgres) ]]; then KEPT_TOOLS=(postgres); fi

log_step 4 "stop the tooling up.sh started"
TOOLING_SUMMARY="$(stop_started_tooling "${KEPT_TOOLS[@]}")" || exit 1
TOOLING_LINE="tooling: $TOOLING_SUMMARY"
if ((${#KEPT_TOOLS[@]} > 0)); then
  TOOLING_LINE+="; ${KEPT_TOOLS[*]} not stopped and kept in tooling.json for the retry"
fi
SUMMARY+=("$TOOLING_LINE; SQL Server and Mailpit left running")

restore_legacy

if [[ -f $UP_FILE ]]; then
  mv -f -- "$UP_FILE" "$UP_FILE.stopped-$STOPPED_AT" || die "cannot rename $UP_FILE"
  SUMMARY+=("state: up.json kept as $UP_FILE.stopped-$STOPPED_AT")
fi
if ((${#KEPT_TOOLS[@]} > 0)); then
  keep_tooling_entries "${KEPT_TOOLS[@]}" || die "cannot rewrite $TOOLING_FILE"
else
  rm -f -- "$TOOLING_FILE"
fi

printf 'OPT-2 stack down for %s:\n' "$REPO"
printf '  %s\n' "${SUMMARY[@]}"
if ((${#FAILED[@]} > 0)); then
  # The kept lock makes the next down.sh redo the failed steps rather than report nothing running.
  printf 'opt2: teardown steps failed: %s; run lock kept, so rerunning harness/repro/down.sh retries them\n' \
    "$(join_or_none "${FAILED[@]}")" >&2
  exit 1
fi
lock_release
printf '  run lock: released\n'
