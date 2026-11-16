#!/usr/bin/env bash
# Command one of the OPT-2 reproducibility pair: boots legacy Masa and every target process with seed data.
set -euo pipefail

# Prints the one-line usage to stderr and exits 2.
usage_error() {
  printf 'usage: harness/repro/up.sh [-h|--help]\n' >&2
  exit 2
}

case $# in
  0) ;;
  1)
    case $1 in
      -h | --help)
        cat <<'EOF'
usage: harness/repro/up.sh

Boots legacy Masa (CommandBox server opt2-legacy) and the OPT-2 target stack, activates cut-over version v0001,
seeds both sides and records the stack in ${OPT2_STATE_DIR:-$HOME/.opt2/state}/up.json. Takes no arguments; it is
configured through the environment below. harness/repro/down.sh stops the stack and releases the run lock.

Environment (* = secret):
  required
    PORT                               legacy ColdFusion port
    MURA_DBHOST MURA_DBPORT MURA_DATABASE MURA_DBUSERNAME MURA_DBPASSWORD*
                                       legacy SQL Server database
    MURA_ADMIN_PASSWORD*               legacy admin password
    PG_HOST PG_PORT PG_DATABASE PG_USER PG_PASSWORD*
                                       PostgreSQL database and the admin login that bootstraps its schemas and roles
    CFCONFIG_ADMINPASSWORD*            ColdFusion Administrator password, passed to the legacy start
  optional
    MURA_ADMIN_USERNAME                legacy admin user (default admin)
    MURA_DBTYPE                        unset or mssql; any other value stops up.sh
    GOOGLE_CLOUD_PROJECT               Pub/Sub emulator project (default opt2-local)
    OPT2_STATE_DIR OPT2_PRISTINE_DIR   absolute, outside the checkout (default $HOME/.opt2/state, $HOME/.opt2/pristine)
    OPT2_TZ                            legacy time zone (default: legacy JVM's -Duser.timezone, else TZ or host zone)
    OPT2_LEGACY_SERVER_NAME            original CommandBox server (default the one serving this checkout or PORT)
  OPT2_CF_*, OPT2_MSSQL_*, OPT2_SQLSERVR_CMD, OPT2_PG_START_CMD, OPT2_LEGACY_START_TIMEOUT_S and MAILPIT_API_URL
  override further defaults; harness/README.md describes every variable. up.sh derives each target process's
  variables from harness/repro/ports.env.

Example, with the required variables exported:
  OPT2_STATE_DIR=/srv/opt2/state harness/repro/up.sh

Exit: 0 stack up, 1 failure, 2 usage error.
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

NODE_VERSION=v22.23.4
NPM_VERSION=11.21.0
ACTIVE_VERSION=v0001
PROCESS_TIMEOUT_S=120
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
CAPTURE_FILE="$OPT2_PRISTINE_DIR/server-capture.json"
NATIVE_TASKS_FILE="$OPT2_PRISTINE_DIR/native-tasks.json"
ENVIRONMENT_FILE="$OPT2_STATE_DIR/baseline/environment.json"
FIXTURES_FILE="$OPT2_STATE_DIR/fixtures.json"
SERVICES=(identity people programs-sites strategies-content communications reporting surveys timesheets finance e-signature stub)
# Setup §3's packages, plus those cfspreadsheet, cfdocument and the bridge's cfschedule need.
CFPM_REQUIRED=(sqlserver image mail zip feed caching orm ajax document spreadsheet scheduler)

CURRENT_STEP="0 (preconditions)"
STARTED_ANYTHING=false
NATIVE_TASK_EXISTED=false
LEGACY_DEVIATION=""
SNAPSHOT_JSON=null
# Name and pid of the target process launch started that up.json does not record yet.
UNRECORDED_NAME=""
UNRECORDED_PID=""

# log_step, remembering the step for the exit message.
step() {
  CURRENT_STEP="$1 ($2)"
  log_step "$@"
}

# An EXIT trap rather than ERR: die exits directly, which an ERR trap never sees. Only an unrecorded launch is stopped.
on_exit() {
  local status=$? count
  ((status != 0)) || return 0
  printf 'opt2: up.sh failed at step %s\n' "$CURRENT_STEP" >&2
  if [[ -n $UNRECORDED_PID ]]; then
    # A subshell, so a stop_process that dies still lets this report finish.
    if count="$(stop_process "$UNRECORDED_PID" "OPT2_SERVICE_NAME=$UNRECORDED_NAME" "OPT2_STATE_DIR=$OPT2_STATE_DIR" &&
      printf '%s' "$STOPPED_PROCESS_COUNT")"; then
      if ((count > 0)); then
        printf 'opt2: up.sh stopped %s (pid %s) because it could not record it in %s/up.json\n' \
          "$UNRECORDED_NAME" "$UNRECORDED_PID" "$OPT2_STATE_DIR" >&2
      else
        printf 'opt2: %s (pid %s), which up.sh could not record in %s/up.json, has already exited\n' \
          "$UNRECORDED_NAME" "$UNRECORDED_PID" "$OPT2_STATE_DIR" >&2
      fi
    else
      printf 'opt2: up.sh could not record %s (pid %s) in %s/up.json nor stop it; stop that process group by hand\n' \
        "$UNRECORDED_NAME" "$UNRECORDED_PID" "$OPT2_STATE_DIR" >&2
    fi
  fi
  if [[ $STARTED_ANYTHING == true ]]; then
    printf 'opt2: what it started is recorded in %s/up.json and tooling.json; run harness/repro/down.sh to stop it\n' \
      "$OPT2_STATE_DIR" >&2
  fi
}
trap on_exit EXIT

# Dies naming the first fixed target port that equals legacy's PORT or is already in use.
check_target_ports() {
  local var
  while IFS= read -r var; do
    [[ ${!var} != "$LEGACY_PORT" ]] || die "$var=${!var} in $REPRO_DIR/ports.env collides with legacy's PORT"
    if ! (assert_port_free "${!var}") 2>/dev/null; then
      die "port ${!var} ($var) is already in use: stop what listens on it (harness/repro/down.sh for an OPT-2 stack)"
    fi
  done < <(compgen -v OPT2_PORT_)
}

# Exports TZ as legacy's JVM resolves its zone: OPT2_TZ, else -Duser.timezone in its JVM arguments, else TZ or the system zone.
resolve_tz() {
  local zone=${OPT2_TZ:-} jvm_args=${OPT2_CF_JVM_ARGS:-} pattern="-Duser\\.timezone=[\"']?([^[:space:]\"']+)"
  if [[ -z $zone ]]; then
    if [[ -z $jvm_args ]]; then jvm_args="$(json_get "$CAPTURE_FILE" jvmArgs 2>/dev/null)" || jvm_args=""; fi
    if [[ $jvm_args =~ $pattern ]]; then zone=${BASH_REMATCH[1]}; fi
  fi
  if [[ -z $zone ]]; then zone="$(legacy_tz)"; fi
  export TZ=$zone
}

# build_package <dir> [ci|build]: npm ci then npm run build in <dir>, or only the named one; output under process-output.
build_package() {
  local dir=$1 only=${2:-} out
  out="$PROCESS_OUTPUT_DIR/build-${dir//\//-}.out"
  printf 'opt2: %s %s\n' "${only:-ci and build}" "$dir" >&2
  if ! (
    cd -- "$REPO/$dir" &&
      { [[ $only == build ]] || CI=true npm ci; } &&
      { [[ $only == ci ]] || npm run build; }
  ) >"$out" 2>&1; then
    tail -n 40 -- "$out" >&2
    die "npm ${only:-ci and build} failed in $dir; full output in $out"
  fi
}

# True when something listens on legacy's port.
legacy_listening() {
  ! (assert_port_free "$LEGACY_PORT") 2>/dev/null
}

# Stops the CommandBox servers on legacy's port: opt2-legacy first, since it shares the original's server home and pid file.
stop_coldfusion() {
  local name status original record
  original="$(json_get "$CAPTURE_FILE" name 2>/dev/null)" || original=""
  for name in "$LEGACY_SERVER_NAME" "$original"; do
    if [[ -z $name || $name == null ]] || ! legacy_listening; then continue; fi
    if [[ $name == "$LEGACY_SERVER_NAME" ]]; then
      record="$(legacy_registration)" || exit 1
      # A registration in another server home is never stopped.
      legacy_record_home_ours "$record" || continue
    fi
    status="$(box server info name="$name" --json </dev/null 2>/dev/null | json_get - status 2>/dev/null)" || status=""
    if [[ -n $status && ${status,,} != stopped ]]; then
      box server stop name="$name" </dev/null >&2 || die "box server stop name=$name failed"
    fi
  done
  wait_port_closed "$LEGACY_PORT" 120
}

# Installs the CFPM_REQUIRED packages the legacy server lacks (setup's missing-tag rule), ColdFusion stopped.
ensure_cfpm_packages() {
  local home cfpm out line name list
  local -a installed=() missing=()
  home="$(legacy_server_home)"
  cfpm="$home/WEB-INF/cfusion/bin/cfpm.sh"
  [[ -x $cfpm ]] || die "no cfpm at $cfpm: the captured server home must hold the installed ACF 2023 engine"
  out="$("$cfpm" list 2>&1)" || die "cfpm list failed: $out"
  while IFS= read -r line; do
    line=${line,,}
    if [[ $line =~ ^[[:space:]]*([a-z0-9_.-]+)[[:space:]]*,[[:space:]]*version ]]; then installed+=("${BASH_REMATCH[1]}"); fi
  done < <(printf '%s\n' "$out" | sed -E -e 's/\x1B\[[0-9;?]*[A-Za-z]//g' -e 's/\r$//')
  for name in "${CFPM_REQUIRED[@]}"; do
    if [[ " ${installed[*]} " != *" $name "* ]]; then missing+=("$name"); fi
  done
  ((${#missing[@]} > 0)) || return 0
  list="$(IFS=,; printf '%s' "${missing[*]}")"
  printf 'opt2: installing missing cfpm packages: %s\n' "$list" >&2
  "$cfpm" install "$list" >&2 || die "cfpm install $list failed"
  printf 'opt2: installed cfpm packages: %s\n' "$list" >&2
}

# Merges the JSON patch on stdin into up.json through a mode-0600 file, since process entries carry role passwords.
write_up_state() {
  local patch
  patch="$(mktemp -- "$OPT2_STATE_DIR/.up-patch.XXXXXX")" || die "cannot create a temp file in $OPT2_STATE_DIR"
  if ! cat >"$patch" || ! harness_run repro:up-state -- write --patch-file "$patch" "$@" >/dev/null; then
    rm -f -- "$patch"
    die "cannot update $OPT2_STATE_DIR/up.json"
  fi
  rm -f -- "$patch"
}

# record_process <name> <pid> [start-time]: records target process <name> in up.json in the form down.sh and the
# harness respawn it from; the start time, when given, is what down.sh checks before signalling <pid>.
record_process() {
  local name=$1 pid=$2 start=${3:-} env_text command port dir
  env_text="$(process_env "$name")" || exit 1
  command="$(process_command_json "$name")" || exit 1
  port="$(process_port "$name")" || exit 1
  dir="$(process_dir "$name")" || exit 1
  # shellcheck disable=SC2016 # JavaScript source
  printf '%s' "$env_text" | node -e '
const [name, pid, start, port, cwd, command, log] = process.argv.slice(1);
const env = {};
for (const line of require("fs").readFileSync(0, "utf8").split("\n")) {
  const eq = line.indexOf("=");
  if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
}
const entry = { pid: Number(pid), port: Number(port), cwd, command: JSON.parse(command), env, log };
if (start !== "") entry.startTime = start;
process.stdout.write(JSON.stringify({ processes: { [name]: entry } }));
' -- "$name" "$pid" "$start" "$port" "$dir" "$command" "$PROCESS_OUTPUT_DIR/$name.out" | write_up_state
}

# Starts target process <name>, records it at once, then waits for its health endpoint; on_exit stops it until recorded.
launch() {
  local name=$1 pid start
  pid="$(start_process "$name")" || die "cannot start $name"
  UNRECORDED_NAME=$name
  UNRECORDED_PID=$pid
  # Empty once the process has exited; down.sh then finds only what is left of its session.
  start="$(_opt2_proc_start_time "$pid")" || start=""
  record_process "$name" "$pid" "$start"
  UNRECORDED_NAME=""
  UNRECORDED_PID=""
  wait_healthy "$name" "$PROCESS_TIMEOUT_S"
  printf 'opt2: %s healthy (pid %s, port %s)\n' "$name" "$pid" "$(process_port "$name")" >&2
}

# Confirms that legacy has finished start-up and renders the admin login form seed-legacy.mjs posts to.
confirm_legacy() {
  local origin page
  origin="$(legacy_origin)"
  # Masa answers / on 127.0.0.1 with a 301 to the site's domain, which still means start-up has finished.
  wait_http "$origin/" 120 200,301,302
  page="$(curl -s --max-time 60 "$origin/admin/?muraAction=clogin.main")" ||
    die "GET $origin/admin/?muraAction=clogin.main failed"
  [[ $page == *'name="csrf_token"'* ]] || die "$origin/admin/?muraAction=clogin.main shows no login form with csrf_token"
}

# Dies unless Mailpit, part of the existing environment, answers on its SMTP and API ports.
confirm_mailpit() {
  local hint='Mailpit belongs to the existing environment; up.sh neither installs nor starts it'
  if ! (wait_port_open "$OPT2_TOOL_PORT_MAILPIT_SMTP" 10) 2>/dev/null; then
    die "Mailpit SMTP is not listening on 127.0.0.1:$OPT2_TOOL_PORT_MAILPIT_SMTP. $hint"
  fi
  if ! (wait_http "$MAILPIT_API_LOCAL/api/v1/info" 10 200) 2>/dev/null; then
    die "Mailpit API $MAILPIT_API_LOCAL/api/v1/info does not answer 200. $hint"
  fi
}

# Recreates Masa's captured site-monitor task against the gateway and resumes it, when the capture holds one.
repoint_site_monitor() {
  local body answer
  [[ -f $NATIVE_TASKS_FILE ]] || return 0
  body="$(mktemp -- "$OPT2_STATE_DIR/.repoint.XXXXXX")" || die "cannot create a temp file in $OPT2_STATE_DIR"
  # shellcheck disable=SC2016 # JavaScript source
  if ! node -e '
const capture = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const name = capture.siteMonitorTask;
const task = typeof name === "string" ? (capture.tasks ?? []).find((t) => t?.task === name) : undefined;
if (task !== undefined) process.stdout.write(JSON.stringify(task));
' -- "$NATIVE_TASKS_FILE" >"$body"; then
    rm -f -- "$body"
    die "cannot read the site-monitor task of $NATIVE_TASKS_FILE"
  fi
  if [[ -s $body ]]; then
    if ! answer="$(node "$LIB_DIR/bridge-call.mjs" scheduler repoint --json "@$body" --origin "$(legacy_origin)")"; then
      rm -f -- "$body"
      die "scheduler.cfm repoint of the site-monitor task failed"
    fi
    printf '%s\n' "$answer" >&2
  fi
  rm -f -- "$body"
}

# --- Preconditions ---------------------------------------------------------------------------------------------

# The pin is confirmed before the lock, any state write or any install.
require_cmd git node
confirm_pin_preflight
lock_acquire up
export MURA_ADMIN_USERNAME="${MURA_ADMIN_USERNAME:-admin}"
require_env PORT PG_HOST PG_PORT PG_USER PG_PASSWORD PG_DATABASE CFCONFIG_ADMINPASSWORD
# mssql-tools18 installs sqlcmd outside PATH; load-fixtures.sh looks it up on PATH too.
if ! command -v sqlcmd >/dev/null 2>&1 && [[ -x /opt/mssql-tools18/bin/sqlcmd ]]; then
  PATH="$PATH:/opt/mssql-tools18/bin"
fi
require_cmd git node npm box sqlcmd pg_isready psql curl tar sha256sum gcloud otelcol-contrib flock setsid ps
check_target_ports
# Every process, tool and harness command shares these with the emulator; the service URL map is always ports.env's.
export GOOGLE_CLOUD_PROJECT="${GOOGLE_CLOUD_PROJECT:-opt2-local}"
export PUBSUB_EMULATOR_HOST="localhost:$OPT2_TOOL_PORT_PUBSUB_EMULATOR"
unset OPT2_SERVICE_URLS
ensure_state_dirs
# The target ports are free, so an earlier stack's processes are gone and its up.json is stale.
rm -f -- "$OPT2_STATE_DIR/up.json"
capture_server
# The captured server's env block decides the Masa settings from here on, for every step and process alike.
adopt_captured_server_env
require_env MURA_DBHOST MURA_DBPORT MURA_DATABASE MURA_DBUSERNAME MURA_DBPASSWORD MURA_ADMIN_PASSWORD
if [[ -n ${MURA_DBTYPE:-} && ${MURA_DBTYPE,,} != mssql ]]; then
  die "MURA_DBTYPE=$MURA_DBTYPE: the OPT-2 stack needs the SQL Server legacy database (pristine backup, opt2_sync," \
    "snapshots); a MySQL fallback is a baseline deviation that stops the migration stages"
fi
resolve_tz
printf 'opt2: TZ=%s\n' "$TZ" >&2

# --- Steps -----------------------------------------------------------------------------------------------------

step 1 "pin and local versions"
[[ "$(node -v)" == "$NODE_VERSION" ]] || die "node $(node -v) found; OPT-2 pins Node.js $NODE_VERSION"
[[ "$(npm -v)" == "$NPM_VERSION" ]] || die "npm $(npm -v) found; OPT-2 pins npm $NPM_VERSION"
# The full pin checker runs on harness's tsx, so it follows the platform and harness installs; the rest build in step 3.
build_package platform
build_package harness ci
harness_run check:pin -- --confirm >&2 || die "the source pin is not confirmed (summary above)"
harness_run baseline:environment -- --phase local >&2 || die "local tool versions do not match their pins (summary above)"

step 2 "secrets"
harness_run repro:secrets >&2 || die "cannot write the local secrets under $OPT2_STATE_DIR/secrets"

step 3 "build"
for dir in gateway web migration; do build_package "$dir"; done
build_package harness build
build_package legacy-fixtures/seed
for name in "${SERVICES[@]}"; do build_package "services/$name"; done
"$REPO/harness/node_modules/.bin/playwright" install chromium >&2 || die "playwright install chromium failed"
"$REPO/harness/node_modules/.bin/tsx" "$REPO/harness/src/repro/ports.ts" --check --legacy-port "$LEGACY_PORT" >&2 ||
  die "$REPRO_DIR/ports.env failed its check (message above)"
OPT2_SERVICE_URLS="$(service_urls_json)" || die "cannot build the OPT2_SERVICE_URLS map"
export OPT2_SERVICE_URLS

step 4 "target tooling"
STARTED_ANYTHING=true
ensure_postgres
ensure_pubsub_emulator
ensure_otelcol

step 5 "quiesce legacy, then baseline it"
ensure_sqlserver
if legacy_listening; then
  capture_native_tasks
  stop_coldfusion
fi
# From here until step 9 no legacy request runs.
ensure_cfpm_packages
if [[ -e $OPT2_PRISTINE_DIR/pristine.json ]]; then
  pristine_restore >&2
else
  pristine_take
fi

step 6 "databases"
summary="$(OPT2_ENV=local "$OPT2_DB" bootstrap --target local)" || die "opt2-db bootstrap --target local failed: $summary"
printf '%s\n' "$summary" >&2
summary="$("$MIGRATE" init-legacy)" ||
  die "opt2-migrate init-legacy failed, so no unit can ever become target-authoritative: $summary"
printf '%s\n' "$summary" >&2
if [[ -f $NATIVE_TASKS_FILE ]]; then
  summary="$("$MIGRATE" scheduler import --file "$NATIVE_TASKS_FILE")" || die "opt2-migrate scheduler import failed: $summary"
  printf '%s\n' "$summary" >&2
  NATIVE_TASK_EXISTED="$(printf '%s\n' "$summary" | json_get - nativeExisted)" ||
    die "opt2-migrate scheduler import reported no nativeExisted"
fi

step 7 "Pub/Sub topology"
harness_run topology -- --target local >&2 || die "cannot create the local Pub/Sub topology"

step 8 "target processes"
for name in "${TARGET_START_ORDER[@]}"; do
  if [[ $name != gateway ]]; then launch "$name"; fi
done
"$OPT2_TASKS" reconcile --include-local-only --as operator >&2 || die "opt2-tasks reconcile failed"

step 9 "legacy start"
# The gateway loads legacy's site registry at start-up and a start-up window needs the gateway, so ColdFusion starts
# first without one. Step 6 recreated the gateway schema: no version is active and no unit is target-authoritative.
summary="$(OPT2_STARTUP_WINDOW_HOLDER='up.sh: no cut-over version active' "$LIB_DIR/legacy-start.sh" --fresh)" ||
  die "legacy-start.sh --fresh failed"
printf '%s\n' "$summary" >&2
confirm_legacy
confirm_mailpit
launch gateway

step 10 "service versions"
status=0
harness_run baseline:environment -- --phase services >&2 || status=$?
case $status in
  0) ;;
  4)
    LEGACY_DEVIATION="$(json_get "$ENVIRONMENT_FILE" settings.deviationReason 2>/dev/null)" || LEGACY_DEVIATION=null
    if [[ $LEGACY_DEVIATION == null ]]; then LEGACY_DEVIATION="MURA_DBTYPE is not mssql: a baseline deviation"; fi
    printf 'opt2: %s; the seed snapshot and backfill are skipped\n' "$LEGACY_DEVIATION" >&2
    ;;
  *) die "recording the service versions failed (exit $status, summary above)" ;;
esac
zone="$(json_get "$ENVIRONMENT_FILE" settings.timeZone)" || die "$ENVIRONMENT_FILE records no legacy time zone"
[[ $zone != null ]] || die "legacy ColdFusion reported no time zone"
[[ $zone == "$TZ" ]] ||
  die "legacy ColdFusion runs in time zone $zone but the target processes run with TZ=$TZ: set OPT2_TZ=$zone and rerun"
ping="$(json_get "$ENVIRONMENT_FILE" settings.ping)" || die "$ENVIRONMENT_FILE records no ping setting"
[[ $ping == false ]] || die "legacy reports ping=$ping although it was started with MURA_PING=false"

step 11 "activate $ACTIVE_VERSION"
harness_run repro:cutover -- activate "$ACTIVE_VERSION" --gateway-url "$OPT2_GATEWAY_ORIGIN_LOCAL" >&2 ||
  die "cannot activate cut-over version $ACTIVE_VERSION"
repoint_site_monitor

step 12 "seed and backfill"
npm --prefix "$REPO/legacy-fixtures/seed" run --silent generate >&2 || die "seed generation failed"
MAILPIT_API_URL="${MAILPIT_API_URL:-$MAILPIT_API_LOCAL}" "$REPO/legacy-fixtures/load-fixtures.sh" >&2 ||
  die "legacy-fixtures/load-fixtures.sh failed unexpectedly"
available="$(json_get "$FIXTURES_FILE" available)" || die "$FIXTURES_FILE records no availability"
if [[ $available != true ]]; then
  printf 'opt2: legacy fixtures unavailable (%s); seeding the synthetic services directly\n' \
    "$(json_get "$FIXTURES_FILE" reason 2>/dev/null || printf 'no reason recorded')" >&2
  npm --prefix "$REPO/legacy-fixtures/seed" run --silent generate:direct >&2 || die "direct seeding of the synthetic services failed"
fi
node "$LIB_DIR/seed-legacy.mjs" --origin "$(legacy_origin)" --seed-dir "$OPT2_STATE_DIR/seed" --fixtures "$available" >&2 ||
  die "loading the seed into legacy failed"
if [[ -z $LEGACY_DEVIATION ]]; then
  summary="$("$MIGRATE" snapshot --kind seed)" || die "opt2-migrate snapshot --kind seed failed: $summary"
  printf '%s\n' "$summary" >&2
  seq="$(printf '%s\n' "$summary" | json_get - seq)" || die "opt2-migrate snapshot reported no seq"
  manifest="$(printf '%s\n' "$summary" | json_get - manifestComplete)" || manifest=false
  store="$(printf '%s\n' "$summary" | json_get - fileStore.status 2>/dev/null)" || store=""
  if [[ $manifest != true && $store != unsupported ]]; then
    "$MIGRATE" files manifest --snapshot "$seq" >&2 || die "opt2-migrate files manifest --snapshot $seq failed"
  fi
  "$MIGRATE" backfill --snapshot "$seq" >&2 || die "opt2-migrate backfill --snapshot $seq failed"
  SNAPSHOT_JSON="{\"seq\":$seq,\"kind\":\"seed\"}"
fi

step 13 "record"
ports=()
for name in "${TARGET_START_ORDER[@]}"; do ports+=("$name" "$(process_port "$name")"); done
# shellcheck disable=SC2016 # JavaScript source
node -e '
const [snapshot, startedAt, nativeTaskExisted, serverName, origin, deviation, ...pairs] = process.argv.slice(1);
const ports = {};
for (let i = 0; i + 1 < pairs.length; i += 2) ports[pairs[i]] = Number(pairs[i + 1]);
process.stdout.write(JSON.stringify({
  ports,
  snapshot: JSON.parse(snapshot),
  startedAt,
  nativeTaskExisted: nativeTaskExisted === "true",
  legacy: { serverName, origin },
  legacyDeviation: deviation === "" ? null : deviation,
}));
' -- "$SNAPSHOT_JSON" "$STARTED_AT" "$NATIVE_TASK_EXISTED" "$LEGACY_SERVER_NAME" "$(legacy_origin)" "$LEGACY_DEVIATION" \
  "${ports[@]}" | write_up_state --fixtures-file "$FIXTURES_FILE"

CURRENT_STEP="13 (done)"
if [[ $SNAPSHOT_JSON == null ]]; then snapshot_text="no seed snapshot ($LEGACY_DEVIATION)"; else snapshot_text="seed snapshot S$seq backfilled"; fi
printf 'OPT-2 stack up: gateway %s (cut-over %s), legacy %s (CommandBox server %s), %d target processes recorded in %s/up.json, fixtures available=%s, %s, TZ=%s. Stop it with harness/repro/down.sh.\n' \
  "$OPT2_GATEWAY_ORIGIN_LOCAL" "$ACTIVE_VERSION" "$(legacy_origin)" "$LEGACY_SERVER_NAME" "${#TARGET_START_ORDER[@]}" \
  "$OPT2_STATE_DIR" "$available" "$snapshot_text" "$TZ"

