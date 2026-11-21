#!/usr/bin/env bash
# Starts or restarts legacy ColdFusion (CommandBox server opt2-legacy) inside a start-up write window, every task paused at boot.
set -euo pipefail

usage() {
  cat <<'EOF'
usage: legacy-start.sh [--fresh | --tasks-file <cfconfig.json> | --original]

  (no argument)              restart: stop and start opt2-legacy, then resume the tasks that were running
  --fresh                    first start from up.sh: record the legacy start environment, drop stale opt2-survey-* tasks
  --tasks-file <file>        start with the scheduled tasks of a CFConfig export, all paused (checkpoint.sh)
  --original                 start the captured original server without the OPT-2 variables (down.sh)

opt2-legacy is OPT2_CF_SERVER_NAME when set; OPT2_PORTS_FILE and OPT2_LOCK_DIR apply as for up.sh.
Prints one JSON summary line on stdout; progress goes to stderr. Exit: 0 started, 1 failure, 2 usage.
EOF
}

MODE=restart
TASKS_FILE=""
case $# in
  0) ;;
  1)
    case $1 in
      --fresh) MODE=fresh ;;
      --original) MODE=original ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        usage >&2
        exit 2
        ;;
    esac
    ;;
  2)
    if [[ $1 != --tasks-file || -z $2 ]]; then
      usage >&2
      exit 2
    fi
    MODE=tasks-file
    TASKS_FILE="$(realpath -m -- "$2")"
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

# shellcheck source=SCRIPTDIR/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
# shellcheck source=SCRIPTDIR/lock.sh
source "$LIB_DIR/lock.sh"
# shellcheck source=SCRIPTDIR/processes.sh
source "$LIB_DIR/processes.sh"

LEGACY_ENV_FILE="$OPT2_STATE_DIR/secrets/legacy-env"
CAPTURE_FILE="$OPT2_PRISTINE_DIR/server-capture.json"
COMMANDBOX_DIR="$OPT2_STATE_DIR/commandbox"
SERVER_JSON="$COMMANDBOX_DIR/server.json"
TASKS_BEFORE="$COMMANDBOX_DIR/tasks-before.json"
TASKS_IMPORT="$COMMANDBOX_DIR/tasks-import.json"
# opt2-legacy's java.io.tmpdir, hence Masa's getTempDirectory(); emptied before every start.
LEGACY_TMP_DIR="$OPT2_STATE_DIR/legacy-tmp"
STARTUP_ROUTE_KEY=startup:legacy-start
SURVEY_TASK_PREFIX=opt2-survey-
START_TIMEOUT_S="${OPT2_LEGACY_START_TIMEOUT_S:-900}"

WINDOW_ID=""
SUMMARY_WINDOW_ID=""

# Prints a field of server-capture.json, empty when absent or null.
capture_value() {
  local value
  value="$(json_get "$CAPTURE_FILE" "$1" 2>/dev/null)" || value=""
  if [[ $value == null ]]; then value=""; fi
  printf '%s\n' "$value"
}

# Prints `export NAME=value` lines for the env block of the captured server's own server.json: settings such as
# its database, encryption key and mail server belong to the start environment opt2-legacy must reproduce.
_captured_server_env() {
  local name
  load_captured_server_env
  for name in "${CAPTURED_SERVER_ENV_NAMES[@]}"; do
    printf 'export %s=%q\n' "$name" "${CAPTURED_SERVER_ENV[$name]}"
  done
}

# Writes legacy-env from this (up.sh) environment: Masa, CFConfig, Java and CommandBox variables, legacy's port.
write_legacy_env() {
  local name temp
  [[ -n ${PORT:-} ]] || die "PORT (legacy ColdFusion's port) is not set: --fresh runs in up.sh's environment"
  temp="$(mktemp -- "$LEGACY_ENV_FILE.XXXXXX")" || die "cannot create a temp file beside $LEGACY_ENV_FILE"
  {
    while IFS= read -r name; do
      case $name in
        MURA_* | CFCONFIG_* | BOX_* | COMMANDBOX_* | JAVA_HOME) printf 'export %s=%q\n' "$name" "${!name}" ;;
      esac
    done < <(compgen -e | LC_ALL=C sort)
    # CommandBox applies a server.json env block over the inherited environment, so these lines come later.
    _captured_server_env
    printf 'export %s=%q\n' OPT2_LEGACY_PORT "$PORT"
  } >"$temp" || {
    rm -f -- "$temp"
    die "cannot write $LEGACY_ENV_FILE"
  }
  mv -f -- "$temp" "$LEGACY_ENV_FILE" || die "cannot rename $temp to $LEGACY_ENV_FILE"
}

# Loads legacy-env, so a caller with a restricted environment (the migration service) starts ColdFusion the same way.
load_legacy_env() {
  if [[ -f $LEGACY_ENV_FILE ]]; then
    # shellcheck source=/dev/null
    source "$LEGACY_ENV_FILE"
  elif [[ $MODE == restart ]]; then
    die "$LEGACY_ENV_FILE is missing: run up.sh first"
  fi
  LEGACY_PORT="${OPT2_LEGACY_PORT:-${PORT:-}}"
  [[ -n $LEGACY_PORT ]] || die "legacy port unknown: set PORT (or OPT2_LEGACY_PORT)"
}

# Dies, ColdFusion untouched, when application start-up would restore a deploy bundle or create the project site.
refuse_startup_writers() {
  local bundle="$REPO/config/setup/deploy/bundle.zip"
  # Masa reads /tmp/MuraBundle.zip whenever MURA_DATASOURCE is set [core/appcfc/applicationSettings.cfm:146].
  if [[ -n ${MURA_DATASOURCE:-} ]]; then bundle=/tmp/MuraBundle.zip; fi
  [[ ! -f $bundle ]] ||
    die "start-up guard (deploy bundle): $bundle exists and Masa start-up would restore it; ColdFusion was not started"
  # Set, even empty, and not `default` (compared case-insensitively), Masa start-up creates the site it names.
  if [[ -n ${MURA_PROJECTSITEID+set} && ${MURA_PROJECTSITEID,,} != default ]]; then
    die "start-up guard (project site): MURA_PROJECTSITEID is '$MURA_PROJECTSITEID', not default; ColdFusion was not started"
  fi
}

# Renders server.json.template by value into $SERVER_JSON; OPT2_CF_* overrides win over server-capture.json.
# The template's disableCodecLib pins ImageIO to the JDK PNG codec: JAI's codecLib PNG plugins are unordered against
# JDK 9+ ones, so each JVM start could pick another encoder and write other rendition bytes.
render_server_json() {
  local home engine jvm
  [[ -f $CAPTURE_FILE ]] || die "$CAPTURE_FILE is missing: run up.sh to capture the legacy server"
  home="${OPT2_CF_SERVER_HOME:-$(capture_value serverHomeDirectory)}"
  engine="${OPT2_CF_ENGINE:-$(capture_value cfengine)}"
  jvm="${OPT2_CF_JVM_ARGS:-$(capture_value jvmArgs)}"
  [[ -n $home ]] || die "no server home: $CAPTURE_FILE has no serverHomeDirectory and OPT2_CF_SERVER_HOME is unset"
  [[ -n $engine ]] || die "no engine: $CAPTURE_FILE has no cfengine and OPT2_CF_ENGINE is unset"
  [[ -n $jvm ]] || die "no JVM arguments: $CAPTURE_FILE has no jvmArgs and OPT2_CF_JVM_ARGS is unset (setup §3 add-opens)"
  [[ $LEGACY_PORT =~ ^[1-9][0-9]*$ ]] || die "legacy port '$LEGACY_PORT' is not a port number"
  [[ ${OPT2_PORT_GATEWAY:-} =~ ^[1-9][0-9]*$ ]] ||
    die "gateway port '${OPT2_PORT_GATEWAY:-}' from $PORTS_FILE is not a port number"
  # CommandBox splits jvm.args on whitespace and unwraps quotes, so the path must hold neither.
  [[ $LEGACY_TMP_DIR != *[[:space:]\"\'\\]* ]] ||
    die "$LEGACY_TMP_DIR holds whitespace, a quote or a backslash, which server.json jvm.args cannot carry"
  # shellcheck disable=SC2016 # JavaScript source
  node -e '
const fs = require("fs");
const [template, out, ...pairs] = process.argv.slice(1);
const values = new Map();
for (let i = 0; i + 1 < pairs.length; i += 2) values.set(pairs[i], pairs[i + 1]);
const numeric = new Set(["@PORT@"]);
const fill = (value) => {
  if (typeof value === "string") {
    if (numeric.has(value)) return Number(values.get(value));
    return value.replace(/@[A-Z_]+@/g, (name) => {
      if (!values.has(name)) throw new Error(`${template} has the unknown placeholder ${name}`);
      return values.get(name);
    });
  }
  if (Array.isArray(value)) return value.map(fill);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]));
  return value;
};
const doc = fill(JSON.parse(fs.readFileSync(template, "utf8")));
const temp = `${out}.${process.pid}.tmp`;
fs.writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temp, out);
' -- "$REPRO_DIR/server.json.template" "$SERVER_JSON" \
    @SERVER_NAME@ "$LEGACY_SERVER_NAME" @CFENGINE@ "$engine" @SERVER_HOME@ "$home" @WEBROOT@ "$REPO" \
    @HOST@ 127.0.0.1 @PORT@ "$LEGACY_PORT" @JVM_ARGS@ "$jvm" @GATEWAY_PORT@ "$OPT2_PORT_GATEWAY" \
    @LEGACY_TMP_DIR@ "$LEGACY_TMP_DIR" ||
    die "cannot render $SERVER_JSON"
}

# Runs a CommandBox command with its output on stderr and no stdin.
box_cmd() {
  box "$@" </dev/null >&2
}

# Prints `<status> <port>` of CommandBox server <name>; nothing when no such server is registered.
server_state() {
  local info
  # `box server info` exits 0 with no output for an unknown name, so the reported name decides.
  info="$(box server info name="$1" --json </dev/null 2>/dev/null)" || return 0
  # shellcheck disable=SC2016 # JavaScript source
  printf '%s' "$info" | node -e '
const text = require("fs").readFileSync(0, "utf8");
const start = text.indexOf("{");
let info;
try { info = start < 0 ? undefined : JSON.parse(text.slice(start)); } catch { info = undefined; }
if (String(info?.name ?? "").toLowerCase() === process.argv[1].toLowerCase()) {
  process.stdout.write(`${String(info.status ?? "unknown").toLowerCase()} ${String(info.port ?? "")}\n`);
}
' -- "$1"
}

# refuse_foreign_registration <record>: dies naming a foreign registration unless this checkout holds the run lock.
refuse_foreign_registration() {
  local record=${1:-} webroot home
  if [[ -z $record ]] || legacy_record_ours "$record" || (lock_assert_mine) 2>/dev/null; then return 0; fi
  webroot="$(legacy_registration_field "$record" webroot)"
  home="$(legacy_registration_field "$record" home)"
  die "CommandBox server $LEGACY_SERVER_NAME is registered with webroot $webroot and server home $home, not this" \
    "checkout's; it is released only while this checkout's stack holds $OPT2_LOCK_FILE (harness/repro/up.sh)"
}

# Releases a LEGACY_SERVER_NAME registration of another checkout or server home, keeping every server file.
release_foreign_registration() {
  local record webroot home
  while true; do
    record="$(legacy_registration)" || exit 1
    if [[ -z $record ]] || legacy_record_ours "$record"; then return 0; fi
    refuse_foreign_registration "$record"
    webroot="$(legacy_registration_field "$record" webroot)"
    home="$(legacy_registration_field "$record" home)"
    legacy_unregister "$(legacy_registration_field "$record" id)" >/dev/null
    printf 'opt2: released the CommandBox registration %s of webroot %s, server home %s; server files kept\n' \
      "$LEGACY_SERVER_NAME" "$webroot" "$home" >&2
  done
}

# Stops opt2-legacy, and the captured original server when it listens on legacy's port; waits for the port to close.
stop_legacy() {
  local record original state
  record="$(legacy_registration)" || exit 1
  # A registration in another server home is never stopped.
  if legacy_record_home_ours "$record" && [[ "$(legacy_registration_field "$record" status)" != stopped ]]; then
    box_cmd server stop name="$LEGACY_SERVER_NAME" || die "box server stop name=$LEGACY_SERVER_NAME failed"
  fi
  original="$(capture_value name)"
  if [[ -n $original && ${original,,} != "${LEGACY_SERVER_NAME,,}" ]]; then
    state="$(server_state "$original")"
    if [[ $state != stopped* && ${state#* } == "$LEGACY_PORT" ]]; then
      box_cmd server stop name="$original" || die "box server stop name=$original failed"
    fi
  fi
  wait_port_closed "$LEGACY_PORT" 120
}

# Recreates $LEGACY_TMP_DIR empty with mode 0700, so the started server's temp directory holds only what it writes.
reset_legacy_tmp() {
  # rm never follows a symbolic link, the directory itself included; --one-file-system keeps it off other mounts.
  rm -rf --one-file-system -- "${LEGACY_TMP_DIR:?}" || die "cannot empty the legacy temp directory $LEGACY_TMP_DIR"
  mkdir -m 0700 -- "$LEGACY_TMP_DIR" || die "cannot create the legacy temp directory $LEGACY_TMP_DIR"
}

# Opens the start-up window over every content unit, unless a holder already leases them.
open_window() {
  local units summary
  if [[ -n ${OPT2_STARTUP_WINDOW_HOLDER:-} ]]; then
    printf 'opt2: the content units are leased by holder %s; no start-up window of its own\n' "$OPT2_STARTUP_WINDOW_HOLDER" >&2
    return 0
  fi
  units="$(content_units)" || exit 1
  if ! summary="$("$MIGRATE" window open --route "$STARTUP_ROUTE_KEY" --units "$units")"; then
    die "the start-up window could not be opened (is the migration service running?); ColdFusion was not started"
  fi
  WINDOW_ID="$(printf '%s\n' "$summary" | json_get - windowId)" || die "opt2-migrate window open printed no windowId"
  SUMMARY_WINDOW_ID=$WINDOW_ID
}

# Completes the start-up window (--forwarded); true if none, closed or import-pending, else false with resolve-window guidance.
close_window() {
  local id=$WINDOW_ID summary state
  [[ -n $id ]] || return 0
  WINDOW_ID=""
  # Always forwarded: ColdFusion is stopped right after the window opens, so legacy may have written from then on.
  if ! summary="$("$MIGRATE" window complete "$id" --forwarded)"; then
    printf 'opt2: closing start-up window %s failed; run: opt2-migrate resolve-window %s\n' "$id" "$id" >&2
    return 1
  fi
  state="$(printf '%s\n' "$summary" | json_get - state 2>/dev/null)" || state=""
  case $state in
    closed) ;;
    import-pending)
      printf 'opt2: start-up window %s is import-pending; the migration service retries its import\n' "$id" >&2
      ;;
    *)
      printf 'opt2: start-up window %s answered state %s; run: opt2-migrate resolve-window %s\n' "$id" "${state:-none}" "$id" >&2
      return 1
      ;;
  esac
}

# On exit or signal, tries to complete an open start-up window (exit 1 on failure); migration retry or resolve-window recovers it.
on_exit() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n $WINDOW_ID ]]; then close_window || status=1; fi
  exit "$status"
}

# Saves the server-level /muraWRM mapping the bridge, fixture and baseline Application.cfc files extend through.
save_mapping() {
  local lines
  local -a to=()
  lines="$(cfconfig_target to)" || exit 1
  mapfile -t to <<<"$lines"
  to[0]="to=${to[0]}"
  box_cmd cfconfig cfmapping save virtual=/muraWRM physical="$REPO" "${to[@]}" ||
    die "box cfconfig cfmapping save /muraWRM failed"
  if [[ ! -f $REPO/core/vendor/testbox/system/TestBox.cfc ]]; then
    printf 'opt2: warning: %s/core/vendor/testbox is missing (box install); the baseline stage reports it\n' "$REPO" >&2
  fi
}

# Writes the desired task set, every task paused, to $TASKS_IMPORT and makes it the server's complete set.
import_paused_tasks() {
  local source=$1
  node "$LIB_DIR/cfconfig-tasks.mjs" pause-all --in "$source" --out "$TASKS_IMPORT" ||
    die "cannot pause the scheduled tasks of $source"
  if [[ $MODE == fresh ]]; then
    node "$LIB_DIR/cfconfig-tasks.mjs" drop-prefix --prefix "$SURVEY_TASK_PREFIX" --in "$TASKS_IMPORT" --out "$TASKS_IMPORT" ||
      die "cannot drop the $SURVEY_TASK_PREFIX tasks of $source"
  fi
  cfconfig_import "$TASKS_IMPORT" >&2 || die "cannot import the paused scheduled tasks"
  rm -f -- "$TASKS_IMPORT"
}

# Starts opt2-legacy in its own session with the start-command variables, never written to server.json.
start_server() {
  local key harness_key
  key="$(secret bridge-hmac-key)" || exit 1
  harness_key="$(secret harness-diagnostic-key)" || exit 1
  # setsid keeps the JVM out of the caller's process group, which the migration service may signal on a timeout.
  # Plugin discovery and DB updates stay off, so application start-up runs neither writer.
  # MURA_BROADCASTCLUSTERCOMMANDS=false: no cluster reload commands, as the start-up guard on content units requires.
  # The port file's Mailpit, as process_env hands it to target communications.
  PORT="$LEGACY_PORT" MURA_PING=false MURA_AUTODISCOVERPLUGINS=false MURA_APPLYDBUPDATES=false \
    MURA_BROADCASTCLUSTERCOMMANDS=false OPT2_BRIDGE_HMAC_KEY="$key" OPT2_HARNESS_KEY="$harness_key" \
    OPT2_GATEWAY_ORIGIN="$OPT2_GATEWAY_ORIGIN_LOCAL" \
    SMTP_HOST=127.0.0.1 SMTP_PORT="$OPT2_TOOL_PORT_MAILPIT_SMTP" MAILPIT_API_URL="$MAILPIT_API_LOCAL" \
    setsid --wait box server start serverConfigFile="$SERVER_JSON" --noSaveSettings </dev/null >&2 ||
    die "box server start serverConfigFile=$SERVER_JSON failed"
}

# Waits until Masa has finished start-up: the first request runs onApplicationStart, then the admin login form renders.
wait_started() {
  local origin=$1 page code
  # Masa answers / on 127.0.0.1 with a 301 to the site's domain, which still means start-up has finished.
  wait_http "$origin/" "$START_TIMEOUT_S" 200,301,302
  page="$(curl -s --max-time 120 -w '\n%{http_code}' "$origin/admin/?muraAction=clogin.main")" ||
    die "GET $origin/admin/?muraAction=clogin.main failed"
  code=${page##*$'\n'}
  if [[ $code != 200 || ($page != *'name="password"'* && $page != *'name="csrf_token"'*) ]]; then
    die "GET $origin/admin/?muraAction=clogin.main answered $code without the login form"
  fi
}

# Calls scheduler.cfm through bridge-call.mjs and prints its JSON answer.
bridge_scheduler() {
  node "$LIB_DIR/bridge-call.mjs" scheduler "$@" --origin "$(legacy_origin)"
}

# Prints a JSON summary line from the named fields.
print_summary() {
  # shellcheck disable=SC2016 # JavaScript source
  node -e '
const [mode, windowId, serverName, port, ping, paused, resumed, duration] = process.argv.slice(1);
process.stdout.write(`${JSON.stringify({
  mode,
  windowId: windowId === "" ? null : windowId,
  serverName,
  port: Number(port),
  ping: ping === "" ? null : ping === "true",
  pausedTasks: JSON.parse(paused),
  resumedTasks: JSON.parse(resumed),
  durationS: Number(duration),
})}\n`);
' -- "$@"
}

# --original: the captured server as it was, without a window, task changes or OPT-2 variables.
run_original() {
  local name was port state record
  [[ -f $CAPTURE_FILE ]] || die "$CAPTURE_FILE is missing: no original legacy server was captured"
  name="$(capture_value name)"
  was="$(capture_value wasRunning)"
  port="$(capture_value port)"
  port=${port:-$LEGACY_PORT}
  if [[ $was != true ]]; then
    printf 'opt2: the original legacy server %s was not running when captured; nothing started\n' "${name:-(none)}" >&2
    print_summary original "" "$name" "$port" "" "[]" "[]" "$SECONDS"
    return 0
  fi
  [[ -n $name ]] || die "$CAPTURE_FILE names no original server"
  # `box server start name=` creates a new server for an unknown name, so the name must be registered.
  [[ -n "$(server_state "$name")" ]] || die "CommandBox has no server named $name"
  # opt2-legacy shares the original's server home, so both report its pid file's state until opt2-legacy is stopped.
  record="$(legacy_registration)" || exit 1
  # A registration in another server home is never stopped.
  if legacy_record_home_ours "$record" && [[ "$(legacy_registration_field "$record" status)" != stopped ]]; then
    log_step a "stop $LEGACY_SERVER_NAME"
    box_cmd server stop name="$LEGACY_SERVER_NAME" || die "box server stop name=$LEGACY_SERVER_NAME failed"
    wait_port_closed "$LEGACY_PORT" 120
  fi
  state="$(server_state "$name")"
  if [[ $state != stopped* ]]; then
    printf 'opt2: the original legacy server %s is already %s\n' "$name" "${state%% *}" >&2
    print_summary original "" "$name" "$port" "" "[]" "[]" "$SECONDS"
    return 0
  fi
  unset MURA_PING MURA_AUTODISCOVERPLUGINS MURA_APPLYDBUPDATES MURA_BROADCASTCLUSTERCOMMANDS OPT2_BRIDGE_HMAC_KEY \
    OPT2_HARNESS_KEY OPT2_GATEWAY_ORIGIN
  log_step b "start the original server $name"
  PORT="$LEGACY_PORT" setsid --wait box server start name="$name" --noSaveSettings </dev/null >&2 ||
    die "box server start name=$name failed"
  log_step c "wait for legacy start-up on port $port"
  wait_http "http://127.0.0.1:$port/" "$START_TIMEOUT_S" 200,301,302
  print_summary original "" "$name" "$port" "" "[]" "[]" "$SECONDS"
}

ensure_state_dirs
if [[ $MODE == fresh ]]; then write_legacy_env; fi
# The first start loads legacy-env too, so the captured server's env block applies to every start alike.
load_legacy_env
require_cmd box node curl setsid
cd -- "$OPT2_STATE_DIR"

if [[ $MODE == original ]]; then
  run_original
  exit 0
fi
if [[ $MODE == tasks-file && ! -f $TASKS_FILE ]]; then die "tasks file $TASKS_FILE does not exist"; fi
refuse_startup_writers

log_step a "render $SERVER_JSON and check the $LEGACY_SERVER_NAME registration"
render_server_json
registration="$(legacy_registration)" || exit 1
# Before the window opens, so a refusal leaves ColdFusion and the content units untouched.
refuse_foreign_registration "$registration"

log_step b "open the start-up window"
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
open_window

log_step c "stop ColdFusion, empty its temp directory and release a foreign $LEGACY_SERVER_NAME registration"
# A ONCE task due before the stop has had its run or never runs, though its exported status stays Running.
stopped_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
stop_legacy
reset_legacy_tmp
# Once ColdFusion is stopped, so a running opt2-legacy is stopped through its registration before it is released.
release_foreign_registration

resume_json="[]"
if [[ $MODE == tasks-file ]]; then
  desired=$TASKS_FILE
else
  log_step d "export the scheduled tasks"
  # Exported once ColdFusion is stopped, so the file holds the tasks' final state and nothing rewrites the config.
  rm -f -- "$TASKS_BEFORE"
  cfconfig_export "$TASKS_BEFORE" >&2 || die "cannot export the scheduled tasks"
  desired=$TASKS_BEFORE
  if [[ $MODE == restart ]]; then
    resume_json="$(node "$LIB_DIR/cfconfig-tasks.mjs" unpaused --in "$TASKS_BEFORE" --json --at "$stopped_at")" ||
      die "cannot list the running tasks of $TASKS_BEFORE"
  fi
fi

log_step e "save the /muraWRM mapping"
save_mapping

log_step f "import the scheduled tasks, all paused"
import_paused_tasks "$desired"
rm -f -- "$TASKS_BEFORE"

log_step g "start $LEGACY_SERVER_NAME on port $LEGACY_PORT"
start_server

log_step h "wait for legacy start-up, then settle it"
wait_started "$(legacy_origin)"
# Requests that reach Masa during its start-up can abort it half done, so one reload of its own runs a complete start-up;
# the content units are still held for this start-up (window or holder), so the reload needs no window of its own.
# The key is the one ColdFusion started with.
harness_key="$(secret harness-diagnostic-key)" || exit 1
OPT2_HARNESS_KEY="$harness_key" node "$LIB_DIR/legacy-settle.mjs" --origin "$(legacy_origin)" --timeout-s "$START_TIMEOUT_S" >&2 ||
  die "legacy start-up did not settle (legacy-settle.mjs)"

log_step i "verify ping and paused tasks"
describe="$(bridge_scheduler describe)" || die "scheduler.cfm describe failed"
# shellcheck disable=SC2016 # JavaScript source
fields="$(printf '%s' "$describe" | node -e '
const answer = JSON.parse(require("fs").readFileSync(0, "utf8"));
if (typeof answer.ping !== "boolean" || !Array.isArray(answer.tasks)) throw new Error("not a scheduler describe answer");
const names = answer.tasks.map((task) => String(task.task));
const running = answer.tasks.filter((task) => task.paused !== true).map((task) => String(task.task));
process.stdout.write(`${answer.ping}\n${JSON.stringify(names)}\n${running.join(", ")}\n`);
')" || die "cannot read the scheduler.cfm describe answer"
mapfile -t described <<<"$fields"
[[ ${described[0]} == false ]] || die "legacy reports ping=${described[0]} although started with MURA_PING=false"
[[ -z ${described[2]:-} ]] || die "scheduled tasks not paused after boot: ${described[2]}"
paused_json=${described[1]}

if [[ $MODE == fresh ]]; then
  log_step j "delete surviving $SURVEY_TASK_PREFIX tasks"
  deleted="$(bridge_scheduler delete --json "{\"prefix\":\"$SURVEY_TASK_PREFIX\"}")" || die "scheduler.cfm delete failed"
  # shellcheck disable=SC2016 # JavaScript source
  paused_json="$(node -e '
const [paused, deleted] = process.argv.slice(1);
const gone = new Set(JSON.parse(deleted).tasks ?? []);
process.stdout.write(JSON.stringify(JSON.parse(paused).filter((name) => !gone.has(name))));
' -- "$paused_json" "$deleted")" || die "cannot read the scheduler.cfm delete answer"
fi

log_step k "close the start-up window"
close_window || exit 1
trap - EXIT INT TERM

resumed_json="[]"
if [[ $resume_json != "[]" ]]; then
  log_step l "resume the tasks that were running"
  resumed="$(bridge_scheduler resume --json "{\"tasks\":$resume_json}")" || die "scheduler.cfm resume failed"
  resumed_json="$(printf '%s\n' "$resumed" | json_get - tasks)" || die "scheduler.cfm resume answered no tasks"
fi

print_summary "$MODE" "$SUMMARY_WINDOW_ID" "$LEGACY_SERVER_NAME" "$LEGACY_PORT" false "$paused_json" "$resumed_json" "$SECONDS"
