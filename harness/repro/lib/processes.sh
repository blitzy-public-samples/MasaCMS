# shellcheck shell=bash
# Per-process environment contract, native start and stop of the OPT-2 target processes, and the reused local tooling.

if [[ -z ${OPT2_COMMON_SH_LOADED:-} ]] || ! declare -F die >/dev/null; then
  printf 'opt2: %s\n' 'processes.sh needs common.sh: source harness/repro/lib/common.sh first' >&2
  exit 1
fi

# --- Process table ---------------------------------------------------------------------------------------------

# Services first, then web and the migration service; the gateway last, since it answers 503 until a version is active.
# shellcheck disable=SC2034 # used by the scripts that source this file
TARGET_START_ORDER=(identity people programs-sites strategies-content communications reporting surveys timesheets finance
  e-signature stub web migration gateway)

# Prints the package directory of target process <name>.
process_dir() {
  local name=${1:?process_dir needs a process name}
  case $name in
    gateway | web | migration) printf '%s\n' "$REPO/$name" ;;
    identity | people | programs-sites | strategies-content | communications | reporting | surveys | timesheets | finance | \
      e-signature | stub) printf '%s\n' "$REPO/services/$name" ;;
    *) die "unknown target process '$name'" ;;
  esac
}

# Prints the PostgreSQL schema of target process <name> (DB_SCHEMAS of harness/src/repro/secrets.ts); nothing for web.
process_schema() {
  local name=${1:?process_schema needs a process name}
  case $name in
    programs-sites) printf 'programs_sites\n' ;;
    strategies-content) printf 'content\n' ;;
    e-signature) printf 'esignature\n' ;;
    identity | people | communications | reporting | surveys | timesheets | finance | stub | gateway | migration)
      printf '%s\n' "$name" ;;
    web) ;;
    *) die "unknown target process '$name'" ;;
  esac
}

# Prints the fixed local port of target process <name> from its OPT2_PORT_<NAME> variable (portVariable of ports.ts).
process_port() {
  local name=${1:?process_port needs a process name} var
  var="OPT2_PORT_${name^^}"
  var=${var//-/_}
  [[ -n ${!var:-} ]] || die "$var is not set: unknown process '$name' or missing from $PORTS_FILE"
  printf '%s\n' "${!var}"
}

# --- Environment contract --------------------------------------------------------------------------------------

_OPT2_SERVICE_URLS_JSON=""

# Prints the OPT2_SERVICE_URLS map: the inherited value, else the serviceUrls of ports.ts --service-urls; cached per shell.
service_urls_json() {
  local tsx="$REPO/harness/node_modules/.bin/tsx" summary
  local -a args=(--service-urls)
  if [[ -z $_OPT2_SERVICE_URLS_JSON ]]; then
    if [[ -n ${OPT2_SERVICE_URLS:-} ]]; then
      _OPT2_SERVICE_URLS_JSON=$OPT2_SERVICE_URLS
    else
      [[ -x $tsx ]] || die "$tsx is missing: run npm ci in harness/ (up.sh step 3) first"
      if [[ -n ${LEGACY_PORT:-} ]]; then args+=(--legacy-port "$LEGACY_PORT"); fi
      summary="$("$tsx" "$REPO/harness/src/repro/ports.ts" "${args[@]}")" || die "ports.ts --service-urls failed: $summary"
      _OPT2_SERVICE_URLS_JSON="$(printf '%s\n' "$summary" | json_get - serviceUrls)" ||
        die "ports.ts --service-urls printed no serviceUrls"
    fi
  fi
  printf '%s\n' "$_OPT2_SERVICE_URLS_JSON"
}

# Prints the legacy server's time zone: TZ, else timedatectl, /etc/timezone or the /etc/localtime link, else UTC.
legacy_tz() {
  local zone="" link
  if [[ -n ${TZ:-} ]]; then
    printf '%s\n' "$TZ"
    return 0
  fi
  if command -v timedatectl >/dev/null 2>&1; then
    zone="$(timedatectl show -p Timezone --value 2>/dev/null)" || zone=""
  fi
  if [[ -z $zone && -s /etc/timezone ]]; then
    read -r zone </etc/timezone || zone=""
  fi
  if [[ -z $zone ]]; then
    link="$(readlink /etc/localtime 2>/dev/null)" || link=""
    if [[ $link == *zoneinfo/* ]]; then zone=${link#*zoneinfo/}; fi
  fi
  printf '%s\n' "${zone:-UTC}"
}

# Prints KEY=value; dies naming only the key when the value spans lines.
_opt2_env_line() {
  [[ $2 != *$'\n'* ]] || die "$1 holds a newline; a process environment is one KEY=value per line"
  printf '%s=%s\n' "$1" "$2"
}

# Prints $1 as one single-quoted POSIX sh word, each embedded ' written as '\''.
_opt2_sh_quote() {
  local escaped="'\\''"
  printf "'%s'\n" "${1//"'"/"$escaped"}"
}

# Masa reads each setting from MURA_<KEY> (core/appcfc/onApplicationStart_include.cfm:136-141) and the target processes
# read them the same way. Prints the exported MURA_* settings for process <name>, sorted by name: the password
# policy, never the database connection, a password, the admin login, the encryption key or the reCAPTCHA secret,
# the reload key only to the processes that mirror legacy's appreloadkey, s3assets, which can embed S3 credentials,
# only to web, and no port pair or web root, which process_env sets.
_opt2_masa_settings_env() {
  local process=${1:?_opt2_masa_settings_env needs a process name} name
  while IFS= read -r name; do
    case $name in
      MURA_AUTORESETPASSWORDS | MURA_BCRYPTPASSWORDS | MURA_ENCRYPTPASSWORDS | MURA_EXPIREPASSWORDS | \
        MURA_STRONGPASSWORDREGEX | MURA_STRONGPASSWORDS) _opt2_env_line "$name" "${!name}" ;;
      MURA_DATASOURCE | MURA_DATABASE | MURA_DBHOST | MURA_DBPORT | MURA_DBUSERNAME | MURA_ADMIN_* | *PASSWORD* | \
        MURA_ENCRYPTIONKEY | MURA_RECAPTCHASECRET | MURA_PORT | MURA_PROXYPORT | MURA_WEBROOT) ;;
      MURA_APPRELOADKEY)
        case $process in
          gateway | web | identity | people | programs-sites | strategies-content | migration)
            _opt2_env_line "$name" "${!name}"
            ;;
        esac
        ;;
      MURA_S3ASSETS)
        if [[ $process == web ]]; then _opt2_env_line "$name" "${!name}"; fi
        ;;
      MURA_*) _opt2_env_line "$name" "${!name}" ;;
    esac
  done < <(compgen -e | LC_ALL=C sort)
}

# Prints the environment of target process <name>, one KEY=value per line, for `env -i`.
process_env() {
  local name=${1:?process_env needs a process name} port schema tz password origin bridge_key reports key
  port="$(process_port "$name")" || exit 1
  schema="$(process_schema "$name")" || exit 1
  service_urls_json >/dev/null
  tz="$(legacy_tz)"

  _opt2_env_line PORT "$port"
  _opt2_env_line OPT2_SERVICE_NAME "$name"
  _opt2_env_line OPT2_ENV local
  _opt2_env_line OPT2_STATE_DIR "$OPT2_STATE_DIR"
  _opt2_env_line TZ "$tz"
  _opt2_env_line PUBSUB_EMULATOR_HOST "localhost:${OPT2_TOOL_PORT_PUBSUB_EMULATOR}"
  _opt2_env_line GOOGLE_CLOUD_PROJECT "${GOOGLE_CLOUD_PROJECT:-opt2-local}"
  _opt2_env_line OTEL_EXPORTER_OTLP_ENDPOINT "http://127.0.0.1:${OPT2_TOOL_PORT_OTLP_HTTP}"
  _opt2_env_line OPT2_JWKS_URL "http://127.0.0.1:${OPT2_PORT_IDENTITY:?OPT2_PORT_IDENTITY is missing from $PORTS_FILE}/.well-known/jwks.json"
  _opt2_env_line OPT2_TOKEN_ISSUER opt2-local-identity
  _opt2_env_line OPT2_TOKEN_AUDIENCE opt2-local
  _opt2_env_line OPT2_GATEWAY_URL "$OPT2_GATEWAY_ORIGIN_LOCAL"
  _opt2_env_line OPT2_MIGRATION_URL "$OPT2_MIGRATION_ORIGIN_LOCAL"
  _opt2_env_line OPT2_SERVICE_URLS "$_OPT2_SERVICE_URLS_JSON"
  _opt2_env_line OPT2_TASKS_ADAPTER local
  _opt2_env_line OPT2_STORAGE_ADAPTER local
  _opt2_masa_settings_env "$name"
  # The values server.json.template gives legacy, so absolute URLs built here match legacy's.
  _opt2_env_line MURA_PORT "$OPT2_PORT_GATEWAY"
  _opt2_env_line MURA_PROXYPORT "$OPT2_PORT_GATEWAY"
  # Masa's webroot is always expandPath('/muraWRM'), the checkout legacy-start.sh serves; only web reads it.
  if [[ $name == web ]]; then _opt2_env_line MURA_WEBROOT "$REPO"; fi

  # The caller's admin PG_USER and PG_PASSWORD serve the local bootstrap only; a process connects as its <schema>_app.
  if [[ -n $schema ]]; then
    require_env PG_HOST PG_PORT PG_DATABASE
    password="$(secret "db-$schema-app")" || exit 1
    _opt2_env_line PG_HOST "$PG_HOST"
    _opt2_env_line PG_PORT "$PG_PORT"
    _opt2_env_line PG_DATABASE "$PG_DATABASE"
    _opt2_env_line PG_USER "${schema}_app"
    _opt2_env_line PG_PASSWORD "$password"
    _opt2_env_line OPT2_DB_AUTH password
  fi

  case $name in
    gateway | migration)
      origin="$(legacy_origin)" || exit 1
      bridge_key="$(secret bridge-hmac-key)" || exit 1
      _opt2_env_line LEGACY_ORIGIN "$origin"
      # legacy-start.sh, run by migration as OPT2_LEGACY_RESTART_CMD, inherits PORT=<migration port>.
      _opt2_env_line OPT2_LEGACY_PORT "$LEGACY_PORT"
      _opt2_env_line OPT2_BRIDGE_HMAC_KEY "$bridge_key"
      # The versions up.sh selected for the fixture capability; both must read the same files.
      _opt2_env_line OPT2_CUTOVER_DIR "${OPT2_CUTOVER_DIR:-$REPO/gateway/cutover}"
      ;;
  esac
  case $name in
    migration)
      require_env MURA_DBHOST MURA_DATABASE MURA_DBUSERNAME MURA_DBPASSWORD
      # MURA_DBTYPE, when set, is already among the Masa settings.
      _opt2_env_line MURA_DBHOST "$MURA_DBHOST"
      _opt2_env_line MURA_DBPORT "${MURA_DBPORT:-1433}"
      _opt2_env_line MURA_DATABASE "$MURA_DATABASE"
      _opt2_env_line MURA_DBUSERNAME "$MURA_DBUSERNAME"
      _opt2_env_line MURA_DBPASSWORD "$MURA_DBPASSWORD"
      if [[ -n ${OPT2_MSSQL_TRUST_SERVER_CERT:-} ]]; then
        _opt2_env_line OPT2_MSSQL_TRUST_SERVER_CERT "$OPT2_MSSQL_TRUST_SERVER_CERT"
      fi
      _opt2_env_line OPT2_PRISTINE_DIR "$OPT2_PRISTINE_DIR"
      # Resolved as test-all.sh and harness/src/lib/paths.ts resolve it: a relative value against the checkout.
      if [[ -n ${OPT2_REPORTS_DIR:-} ]]; then
        reports=$OPT2_REPORTS_DIR
        [[ $reports == /* ]] || reports="$REPO/$reports"
        _opt2_env_line OPT2_REPORTS_DIR "$reports"
      fi
      # A command line that migration runs through /bin/sh.
      _opt2_env_line OPT2_LEGACY_RESTART_CMD "$(_opt2_sh_quote "$REPO/harness/repro/lib/legacy-start.sh")"
      # The caller's port file, server name and lock directory, so that restart addresses this stack.
      for key in OPT2_PORTS_FILE OPT2_CF_SERVER_NAME OPT2_LOCK_DIR; do
        if [[ -n ${!key:-} ]]; then _opt2_env_line "$key" "${!key}"; fi
      done
      ;;
    communications)
      _opt2_env_line SMTP_HOST 127.0.0.1
      _opt2_env_line SMTP_PORT "$OPT2_TOOL_PORT_MAILPIT_SMTP"
      _opt2_env_line MAILPIT_API_URL "$MAILPIT_API_LOCAL"
      ;;
  esac
}

# Prints the migration environment under the service name opt2-cli, for opt2-migrate, opt2-ops and the platform CLIs.
operator_env() {
  local env_text line
  env_text="$(process_env migration)" || exit 1
  while IFS= read -r line; do
    if [[ $line == OPT2_SERVICE_NAME=* ]]; then line=OPT2_SERVICE_NAME=opt2-cli; fi
    printf '%s\n' "$line"
  done <<<"$env_text"
}

# --- Commands and lifecycle ------------------------------------------------------------------------------------

# Prints the argv of target process <name>, one word per line, relative to its package directory.
process_command() {
  local name=${1:?process_command needs a process name}
  case $name in
    web) printf '%s\n' node server.ts --hostname 127.0.0.1 ;;
    migration) printf '%s\n' node dist/cli.js serve ;;
    *)
      process_dir "$name" >/dev/null
      printf '%s\n' node dist/main.js
      ;;
  esac
}

# Prints the argv of target process <name> as a compact JSON array, the up.json `command` form.
process_command_json() {
  local text
  local -a argv=()
  text="$(process_command "${1:?process_command_json needs a process name}")" || exit 1
  mapfile -t argv <<<"$text"
  # shellcheck disable=SC2016 # JavaScript source
  node -e 'process.stdout.write(`${JSON.stringify(process.argv.slice(1))}\n`);' -- "${argv[@]}"
}

# Starts target process <name> in its own session with exactly its process_env; prints the pid, also its group id.
start_process() {
  local name=${1:?start_process needs a process name} dir env_text cmd_text out
  local -a env_lines=() argv=()
  ensure_state_dirs
  dir="$(process_dir "$name")" || exit 1
  # Filled here so each process_env subshell below reuses the map instead of running ports.ts again.
  service_urls_json >/dev/null
  env_text="$(process_env "$name")" || exit 1
  cmd_text="$(process_command "$name")" || exit 1
  mapfile -t env_lines <<<"$env_text"
  mapfile -t argv <<<"$cmd_text"
  # Web's entry is a source file; what must be built is the Next build it serves.
  if [[ $name == web ]]; then _opt2_require_built "$dir/.next/BUILD_ID"; else _opt2_require_built "$dir/${argv[1]}"; fi
  out="$PROCESS_OUTPUT_DIR/$name.out"
  # `env -i` keeps the caller's PORT (legacy's) and admin PG_* out. A background job of a non-interactive shell leads
  # no process group, so setsid execs in place and $! is the process, its group and its session.
  (
    cd -- "$dir" || exit 1
    setsid env -i PATH="$PATH" HOME="$HOME" "${env_lines[@]}" "${argv[@]}" >"$out" 2>&1 </dev/null &
    printf '%s\n' "$!"
  )
}

# Prints the last 50 lines of <name>'s process output to stderr, when it has any.
_opt2_print_output_tail() {
  local out="$PROCESS_OUTPUT_DIR/$1.out"
  [[ -s $out ]] || return 0
  printf 'opt2: last 50 lines of %s:\n' "$out" >&2
  tail -n 50 -- "$out" >&2
}

# Waits up to <timeout-s> for GET /healthz of <name> to answer 200; on timeout prints its output tail and dies.
wait_healthy() {
  local name=${1:?wait_healthy needs a process name} timeout=${2:?wait_healthy needs a timeout} port
  port="$(process_port "$name")" || exit 1
  # wait_http dies on timeout; the subshell keeps this shell alive to print the output first.
  if ! (wait_http "http://127.0.0.1:$port/healthz" "$timeout"); then
    _opt2_print_output_tail "$name"
    die "$name did not become healthy within ${timeout}s"
  fi
}

# True while <pid> exists and is not a zombie.
_opt2_pid_alive() {
  local stat
  kill -0 "$1" 2>/dev/null || return 1
  [[ -r /proc/$1/stat ]] || return 0
  stat="$(<"/proc/$1/stat")" || return 1
  stat=${stat##*) }
  [[ ${stat%% *} != Z ]]
}

# _opt2_proc_env_has <pid> <KEY=value…>: true when the environment <pid> started with holds every KEY=value line; an
# absolute path value also matches another spelling of the same path.
_opt2_proc_env_has() {
  local pid=$1 want line resolved
  local -a env_lines=()
  shift
  mapfile -d '' -t env_lines 2>/dev/null <"/proc/$pid/environ" || return 1
  for want in "$@"; do
    resolved=""
    if [[ ${want#*=} == /* ]]; then resolved="$(realpath -m -- "${want#*=}")" || resolved=""; fi
    for line in "${env_lines[@]}"; do
      if [[ $line == "$want" ]]; then continue 2; fi
      if [[ -n $resolved && $line == "${want%%=*}="/* && $(realpath -m -- "${line#*=}") == "$resolved" ]]; then
        continue 2
      fi
    done
    return 1
  done
}

# _opt2_session_owned <owned> <strays> <pid> [KEY=value…]: fills the arrays with the live members of <pid>'s session and
# group: all owned while <pid> runs, else only those whose environment holds every KEY=value (the number may be reused).
_opt2_session_owned() {
  local -n _opt2_owned_into=$1 _opt2_strays_into=$2
  local pid=$3 member leader_alive=false
  shift 3
  _opt2_owned_into=()
  _opt2_strays_into=()
  if _opt2_pid_alive "$pid"; then
    leader_alive=true
    _opt2_owned_into+=("$pid")
  fi
  while read -r member; do
    ((member > 1 && member != pid && member != $$ && member != BASHPID)) || continue
    if [[ $leader_alive == true ]] || { (($# > 0)) && _opt2_proc_env_has "$member" "$@"; }; then
      _opt2_owned_into+=("$member")
    else
      _opt2_strays_into+=("$member")
    fi
  done < <(ps -e -o pid=,pgid=,sid=,stat= 2>/dev/null |
    awk -v p="$pid" '($2 == p || $3 == p) && $4 !~ /^Z/ { print $1 }')
}

# _opt2_track <array> <pid…>: appends `<pid>:<start time>:<pgid>` for each running pid the array does not hold yet.
_opt2_track() {
  local -n _opt2_track_into=$1
  local member start pgid
  shift
  for member in "$@"; do
    [[ " ${_opt2_track_into[*]} " != *" $member:"* ]] || continue
    start="$(_opt2_proc_start_time "$member")" || continue
    pgid="$(_opt2_proc_stat "$member" 5)" || continue
    _opt2_track_into+=("$member:$start:$pgid")
  done
}

# _opt2_tracked_running <array> <entry…>: fills the array with the _opt2_track entries still running as that process.
_opt2_tracked_running() {
  local -n _opt2_running_into=$1
  local entry rest start
  shift
  _opt2_running_into=()
  for entry in "$@"; do
    rest=${entry#*:}
    _opt2_pid_alive "${entry%%:*}" || continue
    start="$(_opt2_proc_start_time "${entry%%:*}")" || continue
    if [[ $start == "${rest%%:*}" ]]; then _opt2_running_into+=("$entry"); fi
  done
}

# stop_process <pid> [KEY=value…]: stops what _opt2_session_owned finds owned of <pid>'s session and group: TERM,
# KILL after 15 s; dies when one survives SIGKILL. Sets STOPPED_PROCESS_COUNT to the number of owned processes found.
stop_process() {
  local pid=${1:?stop_process needs a pid} entry leader=false deadline
  local -a owned=() strays=() tracked=() running=()
  # Signalling group 1 would reach every process.
  if ! [[ $pid =~ ^[1-9][0-9]*$ ]] || ((pid <= 1)); then die "stop_process: '$pid' is not a pid above 1"; fi
  shift
  STOPPED_PROCESS_COUNT=0
  _opt2_session_owned owned strays "$pid" "$@"
  if ((${#strays[@]} > 0)); then
    printf 'opt2: pid(s) %s in the session of exited pid %s do not carry %s in their environment; left running\n' \
      "${strays[*]}" "$pid" "${*:-an ownership contract}" >&2
  fi
  ((${#owned[@]} > 0)) || return 0
  if [[ ${owned[0]} == "$pid" ]]; then leader=true; fi
  _opt2_track tracked "${owned[@]}"
  STOPPED_PROCESS_COUNT=${#tracked[@]}
  if [[ $leader == true ]]; then kill -TERM -- "-$pid" 2>/dev/null || kill -TERM -- "$pid" 2>/dev/null || true; fi
  for entry in "${tracked[@]}"; do
    # Whatever the group's TERM reached gets no second one, which would cut short a once-only shutdown handler.
    if [[ $leader == true && (${entry%%:*} == "$pid" || ${entry##*:} == "$pid") ]]; then continue; fi
    kill -TERM -- "${entry%%:*}" 2>/dev/null || true
  done
  deadline=$((SECONDS + 15))
  while true; do
    _opt2_session_owned owned strays "$pid" "$@"
    _opt2_track tracked "${owned[@]}"
    _opt2_tracked_running running "${tracked[@]}"
    ((${#running[@]} > 0)) || return 0
    ((SECONDS < deadline)) || break
    sleep 0.2
  done
  # A running tracked member keeps the group number in use, so the group is still this one.
  if [[ $leader == true && " ${running[*]} " == *":$pid "* ]]; then kill -KILL -- "-$pid" 2>/dev/null || true; fi
  for entry in "${running[@]}"; do kill -KILL -- "${entry%%:*}" 2>/dev/null || true; done
  deadline=$((SECONDS + 5))
  while true; do
    _opt2_tracked_running running "${tracked[@]}"
    ((${#running[@]} > 0)) || return 0
    ((SECONDS < deadline)) || die "pid(s) ${running[*]%%:*} of session $pid survived SIGKILL"
    sleep 0.2
  done
}

# start_background <name> <cmd…>: starts a tooling command in its own session with the caller's environment, cwd
# OPT2_STATE_DIR, output to <name>.out; prints the pid.
start_background() {
  local name=${1:?start_background needs a name} out
  shift
  (($# > 0)) || die "start_background $name needs a command"
  ensure_state_dirs
  out="$PROCESS_OUTPUT_DIR/$name.out"
  (
    cd -- "$OPT2_STATE_DIR" || exit 1
    setsid "$@" >"$out" 2>&1 </dev/null &
    printf '%s\n' "$!"
  )
}

# tooling_record <name> started|reused [pid [start-time]]: records whether up.sh started the tool, with the pid's start
# time (read when not given); `reused` keeps a started entry whose pid is unknown or still runs as recorded.
tooling_record() {
  local name=${1:?tooling_record needs a name} state=${2:?tooling_record needs a state} pid=${3:-} start=${4:-}
  local file="$OPT2_STATE_DIR/tooling.json" previous previous_pid previous_start
  [[ $state == started || $state == reused ]] || die "tooling_record state must be started or reused, got '$state'"
  [[ -z $pid || $pid =~ ^[1-9][0-9]*$ ]] || die "tooling_record pid must be a positive integer, got '$pid'"
  [[ -z $start || ($start =~ ^[0-9]+$ && -n $pid) ]] ||
    die "tooling_record start time must be digits after a pid, got '$start'"
  if [[ -n $pid && -z $start ]]; then start="$(_opt2_proc_start_time "$pid")" || start=""; fi
  ensure_state_dirs
  if [[ $state == reused && -f $file ]]; then
    # Prints `started:<pid>:<start time>` (each empty when unknown) for a started entry, nothing otherwise.
    # shellcheck disable=SC2016 # JavaScript source
    previous="$(node -e '
const entry = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
const pid = Number.isInteger(entry?.pid) ? entry.pid : "";
const start = typeof entry?.startTime === "string" && /^\d+$/.test(entry.startTime) ? entry.startTime : "";
if (entry?.state === "started") process.stdout.write(`started:${pid}:${pid === "" ? "" : start}`);
' -- "$file" "$name")" || die "cannot read $file"
    if [[ $previous == started:* ]]; then
      previous=${previous#started:}
      previous_pid=${previous%%:*}
      previous_start=${previous#*:}
      if [[ -z $previous_pid ]] || { _opt2_pid_alive "$previous_pid" &&
        { [[ -z $previous_start ]] || [[ $(_opt2_proc_start_time "$previous_pid") == "$previous_start" ]]; }; }; then
        return 0
      fi
    fi
  fi
  # shellcheck disable=SC2016 # JavaScript source
  node -e '
const fs = require("fs");
const [file, name, state, pid, startTime] = process.argv.slice(1);
let doc = {};
try {
  doc = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (err) {
  if (err.code !== "ENOENT") throw err;
}
if (doc === null || typeof doc !== "object" || Array.isArray(doc)) throw new Error(`${file} is not a JSON object`);
doc[name] = {
  state,
  pid: pid === "" ? null : Number(pid),
  startTime: startTime === "" ? null : startTime,
  recordedAt: new Date().toISOString(),
};
const tmp = `${file}.${process.pid}.tmp`;
fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(tmp, file);
' -- "$file" "$name" "$state" "$pid" "$start" || die "cannot update $file"
}

# --- Reused tooling (started only when not already running) ----------------------------------------------------

# _opt2_stop_tool <name> <pid> <start-time>: stops a tool up.sh started unless <pid> now runs with another start time;
# prints stopped, gone or foreign.
_opt2_stop_tool() {
  local name=$1 pid=$2 start=$3 actual
  if _opt2_pid_alive "$pid"; then
    actual="$(_opt2_proc_start_time "$pid")" || actual=""
    if [[ -z $start || $actual != "$start" ]]; then
      printf 'opt2: pid %s recorded for %s is not the process up.sh started (start time %s, recorded %s); left running\n' \
        "$pid" "$name" "${actual:-unknown}" "${start:-none}" >&2
      printf 'foreign\n'
      return 0
    fi
  fi
  stop_process "$pid" OPT2_STATE_DIR="$OPT2_STATE_DIR"
  if ((STOPPED_PROCESS_COUNT > 0)); then printf 'stopped\n'; else printf 'gone\n'; fi
}

# Waits up to <timeout-s> for `<check…>` to succeed; on timeout stops the tool started as <pid> at <start-time>
# (_opt2_stop_tool), prints <name>'s output tail and dies.
_opt2_await_tool() {
  local name=$1 pid=$2 start=$3 timeout=$4 deadline
  shift 4
  deadline=$((SECONDS + timeout))
  until "$@"; do
    if ((SECONDS >= deadline)); then
      _opt2_stop_tool "$name" "$pid" "$start" >/dev/null
      _opt2_print_output_tail "$name"
      die "$name did not become ready within ${timeout}s"
    fi
    sleep 1
  done
}

# True when PostgreSQL answers on PG_HOST:PG_PORT.
_opt2_pg_ready() {
  pg_isready -q -h "$PG_HOST" -p "$PG_PORT" >/dev/null 2>&1
}

# Prints the postmaster pid of the pg_lsclusters cluster listening on PG_PORT; nothing when not found.
_opt2_postmaster_pid() {
  local datadir pid=""
  command -v pg_lsclusters >/dev/null 2>&1 || return 0
  datadir="$(pg_lsclusters -h 2>/dev/null | awk -v p="$PG_PORT" '$3 == p { print $6; exit }')" || datadir=""
  if [[ -n $datadir && -r $datadir/postmaster.pid ]]; then
    read -r pid <"$datadir/postmaster.pid" || pid=""
  fi
  if [[ $pid =~ ^[1-9][0-9]*$ ]]; then printf '%s\n' "$pid"; fi
}

# Starts PostgreSQL unless it answers on PG_HOST:PG_PORT: OPT2_PG_START_CMD, else pg_ctlcluster 16 main start.
ensure_postgres() {
  local deadline
  require_env PG_HOST PG_PORT
  require_cmd pg_isready
  if _opt2_pg_ready; then
    tooling_record postgres reused
    return 0
  fi
  if [[ -n ${OPT2_PG_START_CMD:-} ]]; then
    bash -c "$OPT2_PG_START_CMD" || die "OPT2_PG_START_CMD failed"
  elif command -v pg_ctlcluster >/dev/null 2>&1; then
    pg_ctlcluster 16 main start || die "pg_ctlcluster 16 main start failed"
  else
    die "PostgreSQL is not answering on $PG_HOST:$PG_PORT and pg_ctlcluster is unavailable: start PostgreSQL 16 (setup §8) or set OPT2_PG_START_CMD"
  fi
  deadline=$((SECONDS + 60))
  until _opt2_pg_ready; do
    ((SECONDS < deadline)) || die "PostgreSQL did not become ready on $PG_HOST:$PG_PORT within 60s"
    sleep 1
  done
  tooling_record postgres started "$(_opt2_postmaster_pid)"
}

# Starts the Pub/Sub emulator on localhost:OPT2_TOOL_PORT_PUBSUB_EMULATOR unless that port already accepts connections.
ensure_pubsub_emulator() {
  local port=$OPT2_TOOL_PORT_PUBSUB_EMULATOR pid start
  if _opt2_port_open "$port"; then
    tooling_record pubsub-emulator reused
    return 0
  fi
  require_cmd gcloud
  pid="$(start_background pubsub-emulator gcloud beta emulators pubsub start --host-port="localhost:$port" \
    --project="${GOOGLE_CLOUD_PROJECT:-opt2-local}")" || exit 1
  start="$(_opt2_proc_start_time "$pid")" || start=""
  _opt2_await_tool pubsub-emulator "$pid" "$start" 60 _opt2_port_open "$port"
  tooling_record pubsub-emulator started "$pid" "$start"
}

# Prints the pid listening on TCP <port> as ss reports it; nothing when none is visible.
_opt2_listener_pid() {
  local out
  out="$(ss -Hltnp "sport = :${1:?_opt2_listener_pid needs a port}" 2>/dev/null)" || return 0
  if [[ $out =~ pid=([1-9][0-9]*) ]]; then printf '%s\n' "${BASH_REMATCH[1]}"; fi
}

# True when <pid> runs this checkout's otelcol-config.yaml with this shell's OPT2_STATE_DIR, the root of its file sink.
_opt2_is_repro_otelcol() {
  local pid=$1 config="$REPRO_DIR/otelcol-config.yaml" i entry configured=false
  local -a argv=() environ=()
  { mapfile -d '' argv <"/proc/$pid/cmdline" && mapfile -d '' environ <"/proc/$pid/environ"; } 2>/dev/null || return 1
  for ((i = 0; i < ${#argv[@]}; i++)); do
    if [[ ${argv[i]} == "--config=$config" || (${argv[i]} == --config && ${argv[i + 1]:-} == "$config") ]]; then
      configured=true
    fi
  done
  [[ $configured == true ]] || return 1
  for entry in "${environ[@]}"; do
    if [[ $entry == "OPT2_STATE_DIR=$OPT2_STATE_DIR" ]]; then return 0; fi
  done
  return 1
}

# Prints the pid of this run's collector when it holds OPT2_TOOL_PORT_OTLP_HTTP, nothing when the port is free; dies
# when any other process holds the port.
repro_otelcol_pid() {
  local port=$OPT2_TOOL_PORT_OTLP_HTTP pid cmdline
  local -a argv=()
  _opt2_port_open "$port" || return 0
  require_cmd ss
  pid="$(_opt2_listener_pid "$port")"
  if [[ -n $pid ]] && _opt2_is_repro_otelcol "$pid"; then
    printf '%s\n' "$pid"
    return 0
  fi
  if [[ -n $pid ]]; then mapfile -d '' argv 2>/dev/null <"/proc/$pid/cmdline" || argv=(); fi
  cmdline="${argv[*]:-command line unknown}"
  die "port $port (OPT2_TOOL_PORT_OTLP_HTTP) is held by pid ${pid:-unknown} (${cmdline//[[:cntrl:]]/ })," \
    "not this checkout's otelcol-config.yaml collector for this OPT2_STATE_DIR, so spans would not reach" \
    "$OPT2_STATE_DIR/otel/traces.jsonl: stop it, or run harness/repro/down.sh with the OPT2_STATE_DIR that started it"
}

# Starts otelcol-contrib with otelcol-config.yaml on 127.0.0.1:OPT2_TOOL_PORT_OTLP_HTTP; reuses only this run's own.
ensure_otelcol() {
  local port=$OPT2_TOOL_PORT_OTLP_HTTP pid start
  pid="$(repro_otelcol_pid)" || exit 1
  if [[ -n $pid ]]; then
    tooling_record otelcol reused "$pid"
    return 0
  fi
  require_cmd otelcol-contrib
  # The config writes ${env:OPT2_STATE_DIR}/otel/traces.jsonl; common.sh exports OPT2_STATE_DIR.
  mkdir -p -- "$OPT2_STATE_DIR/otel"
  pid="$(start_background otelcol otelcol-contrib --config "$REPRO_DIR/otelcol-config.yaml" \
    --set="receivers::otlp::protocols::http::endpoint=127.0.0.1:$port")" || exit 1
  start="$(_opt2_proc_start_time "$pid")" || start=""
  _opt2_await_tool otelcol "$pid" "$start" 30 _opt2_port_open "$port"
  tooling_record otelcol started "$pid" "$start"
}

# True when MURA_DBHOST:MURA_DBPORT accepts a connection and SQL Server answers SELECT 1.
_opt2_sqlserver_ready() {
  # shellcheck disable=SC2016 # expanded by the inner bash
  timeout 5 bash -c 'exec 3<>"/dev/tcp/$0/$1"' "$MURA_DBHOST" "${MURA_DBPORT:-1433}" 2>/dev/null &&
    sqlcmd_legacy --db master -Q "SELECT 1" >/dev/null 2>&1
}

# Starts SQL Server (setup §2) unless it already answers on MURA_DBHOST:MURA_DBPORT.
ensure_sqlserver() {
  local pid start
  require_env MURA_DBHOST MURA_DBUSERNAME MURA_DBPASSWORD MURA_DATABASE
  if _opt2_sqlserver_ready; then
    tooling_record sqlserver reused
    return 0
  fi
  # Prefix assignments reach the server's environment, keeping the SA password out of its argv.
  pid="$(ACCEPT_EULA=Y MSSQL_PID=Express MSSQL_SA_PASSWORD="$MURA_DBPASSWORD" \
    start_background sqlservr "${OPT2_SQLSERVR_CMD:-/opt/mssql/bin/sqlservr}")" || exit 1
  start="$(_opt2_proc_start_time "$pid")" || start=""
  _opt2_await_tool sqlserver "$pid" "$start" 120 _opt2_sqlserver_ready
  tooling_record sqlserver started "$pid" "$start"
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

# stop_started_tooling [keep…]: stops every tool tooling.json records as started, except the named ones and SQL Server,
# which is never stopped; Mailpit is never managed. Prints `stopped …; already gone …; left running …`.
stop_started_tooling() {
  local file="$OPT2_STATE_DIR/tooling.json" entries name state pid start outcome
  local -a stopped=() gone=() kept=()
  if [[ -f $file ]]; then
    # shellcheck disable=SC2016 # JavaScript source
    entries="$(node -e '
const doc = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
for (const [name, entry] of Object.entries(doc)) {
  const pid = Number.isInteger(entry?.pid) ? String(entry.pid) : "";
  const start = typeof entry?.startTime === "string" && /^\d+$/.test(entry.startTime) ? entry.startTime : "";
  // An empty pid with a start time would shift the tab-split fields, so a start time goes only with a pid.
  process.stdout.write(`${name}\t${String(entry?.state)}\t${pid}\t${pid === "" ? "" : start}\n`);
}
' -- "$file")" || die "cannot read $file"
    while IFS=$'\t' read -r name state pid start; do
      [[ $state == started && $name != sqlserver && " $* " != *" $name "* ]] || continue
      case $name in
        postgres)
          require_env PG_HOST PG_PORT
          if ! _opt2_pg_ready; then
            gone+=("$name")
            continue
          fi
          if [[ -n ${OPT2_PG_STOP_CMD:-} ]]; then
            bash -c "$OPT2_PG_STOP_CMD" || die "OPT2_PG_STOP_CMD failed"
          else
            pg_ctlcluster 16 main stop || die "pg_ctlcluster 16 main stop failed"
          fi
          stopped+=("$name")
          ;;
        *)
          if [[ -z $pid ]]; then
            kept+=("$name (no pid recorded)")
            continue
          fi
          outcome="$(_opt2_stop_tool "$name" "$pid" "$start")" || exit 1
          case $outcome in
            stopped) stopped+=("$name (pid $pid)") ;;
            foreign) kept+=("$name (pid $pid)") ;;
            *) gone+=("$name") ;;
          esac
          ;;
      esac
    done <<<"$entries"
  fi
  printf 'stopped %s; already gone %s; left running %s\n' "$(join_or_none "${stopped[@]}")" \
    "$(join_or_none "${gone[@]}")" "$(join_or_none "${kept[@]}")"
}
