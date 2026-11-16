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
  [[ -n ${!var:-} ]] || die "$var is not set: unknown process '$name' or missing from $REPRO_DIR/ports.env"
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
# only to web, and no port pair, which process_env sets.
_opt2_masa_settings_env() {
  local process=${1:?_opt2_masa_settings_env needs a process name} name
  while IFS= read -r name; do
    case $name in
      MURA_AUTORESETPASSWORDS | MURA_BCRYPTPASSWORDS | MURA_ENCRYPTPASSWORDS | MURA_EXPIREPASSWORDS | \
        MURA_STRONGPASSWORDREGEX | MURA_STRONGPASSWORDS) _opt2_env_line "$name" "${!name}" ;;
      MURA_DATASOURCE | MURA_DATABASE | MURA_DBHOST | MURA_DBPORT | MURA_DBUSERNAME | MURA_ADMIN_* | *PASSWORD* | \
        MURA_ENCRYPTIONKEY | MURA_RECAPTCHASECRET | MURA_PORT | MURA_PROXYPORT) ;;
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
  local name=${1:?process_env needs a process name} port schema tz password origin bridge_key reports
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
  _opt2_env_line OPT2_JWKS_URL "http://127.0.0.1:${OPT2_PORT_IDENTITY:?OPT2_PORT_IDENTITY is missing from ports.env}/.well-known/jwks.json"
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
      ;;
  esac
  case $name in
    gateway)
      _opt2_env_line OPT2_CUTOVER_DIR "$REPO/gateway/cutover"
      ;;
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
  local name=${1:?process_command needs a process name} port
  case $name in
    web)
      port="$(process_port web)" || exit 1
      printf '%s\n' node node_modules/next/dist/bin/next start -H 127.0.0.1 -p "$port"
      ;;
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
  _opt2_require_built "$dir/${argv[1]}"
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

# Waits up to <timeout-s> for GET /healthz of <name> to answer 200 (web: any status); on timeout prints its output
# tail and dies.
wait_healthy() {
  local name=${1:?wait_healthy needs a process name} timeout=${2:?wait_healthy needs a timeout} port expect=200
  port="$(process_port "$name")" || exit 1
  if [[ $name == web ]]; then expect=any; fi
  # wait_http dies on timeout; the subshell keeps this shell alive to print the output first.
  if ! (wait_http "http://127.0.0.1:$port/healthz" "$timeout" "$expect"); then
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

# True while process group <pgid> holds a process that is not a zombie.
_opt2_group_alive() {
  ps -e -o pgid=,stat= 2>/dev/null | awk -v g="$1" '$1 == g && $2 !~ /^Z/ { found = 1 } END { exit !found }'
}

# True while the kill target (`-<pgid>` or `<pid>`) has a live process.
_opt2_kill_target_alive() {
  if [[ $1 == -* ]]; then _opt2_group_alive "${1#-}"; else _opt2_pid_alive "$1"; fi
}

# Stops <pid> and its process group: TERM, KILL after 15 s; the single pid when it leads no group. No-op when not running.
stop_process() {
  local pid=${1:?stop_process needs a pid} target deadline
  # Signalling group 1 would reach every process.
  if ! [[ $pid =~ ^[1-9][0-9]*$ ]] || ((pid <= 1)); then die "stop_process: '$pid' is not a pid above 1"; fi
  _opt2_pid_alive "$pid" || return 0
  target="-$pid"
  if ! kill -TERM -- "$target" 2>/dev/null; then
    target=$pid
    kill -TERM -- "$target" 2>/dev/null || return 0
  fi
  deadline=$((SECONDS + 15))
  while _opt2_kill_target_alive "$target"; do
    if ((SECONDS >= deadline)); then
      kill -KILL -- "$target" 2>/dev/null || true
      break
    fi
    sleep 0.2
  done
  deadline=$((SECONDS + 5))
  while _opt2_kill_target_alive "$target"; do
    ((SECONDS < deadline)) || die "process $target survived SIGKILL"
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

# tooling_record <name> started|reused [pid]: records in tooling.json whether up.sh started the tool. A `reused`
# record keeps a `started` entry whose pid is unknown or still running, so down.sh stops what an earlier up.sh started.
tooling_record() {
  local name=${1:?tooling_record needs a name} state=${2:?tooling_record needs a state} pid=${3:-}
  local file="$OPT2_STATE_DIR/tooling.json" previous
  [[ $state == started || $state == reused ]] || die "tooling_record state must be started or reused, got '$state'"
  [[ -z $pid || $pid =~ ^[1-9][0-9]*$ ]] || die "tooling_record pid must be a positive integer, got '$pid'"
  ensure_state_dirs
  if [[ $state == reused && -f $file ]]; then
    # Prints `started:<pid>` (pid empty when unknown) for a started entry, nothing otherwise.
    # shellcheck disable=SC2016 # JavaScript source
    previous="$(node -e '
const entry = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
if (entry?.state === "started") process.stdout.write(`started:${Number.isInteger(entry.pid) ? entry.pid : ""}`);
' -- "$file" "$name")" || die "cannot read $file"
    if [[ $previous == started: ]] || { [[ $previous == started:* ]] && _opt2_pid_alive "${previous#started:}"; }; then
      return 0
    fi
  fi
  # shellcheck disable=SC2016 # JavaScript source
  node -e '
const fs = require("fs");
const [file, name, state, pid] = process.argv.slice(1);
let doc = {};
try {
  doc = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (err) {
  if (err.code !== "ENOENT") throw err;
}
if (doc === null || typeof doc !== "object" || Array.isArray(doc)) throw new Error(`${file} is not a JSON object`);
doc[name] = { state, pid: pid === "" ? null : Number(pid), recordedAt: new Date().toISOString() };
const tmp = `${file}.${process.pid}.tmp`;
fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(tmp, file);
' -- "$file" "$name" "$state" "$pid" || die "cannot update $file"
}

# --- Reused tooling (started only when not already running) ----------------------------------------------------

# Waits up to <timeout-s> for `<check…>` to succeed; on timeout stops <pid>, prints <name>'s output tail and dies.
_opt2_await_tool() {
  local name=$1 pid=$2 timeout=$3 deadline
  shift 3
  deadline=$((SECONDS + timeout))
  until "$@"; do
    if ((SECONDS >= deadline)); then
      stop_process "$pid"
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
  local port=$OPT2_TOOL_PORT_PUBSUB_EMULATOR pid
  if _opt2_port_open "$port"; then
    tooling_record pubsub-emulator reused
    return 0
  fi
  require_cmd gcloud
  pid="$(start_background pubsub-emulator gcloud beta emulators pubsub start --host-port="localhost:$port" \
    --project="${GOOGLE_CLOUD_PROJECT:-opt2-local}")" || exit 1
  _opt2_await_tool pubsub-emulator "$pid" 60 _opt2_port_open "$port"
  tooling_record pubsub-emulator started "$pid"
}

# Starts otelcol-contrib with otelcol-config.yaml on 127.0.0.1:OPT2_TOOL_PORT_OTLP_HTTP unless that port is open.
ensure_otelcol() {
  local port=$OPT2_TOOL_PORT_OTLP_HTTP pid
  if _opt2_port_open "$port"; then
    tooling_record otelcol reused
    return 0
  fi
  require_cmd otelcol-contrib
  # The config writes ${env:OPT2_STATE_DIR}/otel/traces.jsonl; common.sh exports OPT2_STATE_DIR.
  mkdir -p -- "$OPT2_STATE_DIR/otel"
  pid="$(start_background otelcol otelcol-contrib --config "$REPRO_DIR/otelcol-config.yaml" \
    --set="receivers::otlp::protocols::http::endpoint=127.0.0.1:$port")" || exit 1
  _opt2_await_tool otelcol "$pid" 30 _opt2_port_open "$port"
  tooling_record otelcol started "$pid"
}

# True when MURA_DBHOST:MURA_DBPORT accepts a connection and SQL Server answers SELECT 1.
_opt2_sqlserver_ready() {
  # shellcheck disable=SC2016 # expanded by the inner bash
  timeout 5 bash -c 'exec 3<>"/dev/tcp/$0/$1"' "$MURA_DBHOST" "${MURA_DBPORT:-1433}" 2>/dev/null &&
    sqlcmd_legacy --db master -Q "SELECT 1" >/dev/null 2>&1
}

# Starts SQL Server (setup §2) unless it already answers on MURA_DBHOST:MURA_DBPORT.
ensure_sqlserver() {
  local pid
  require_env MURA_DBHOST MURA_DBUSERNAME MURA_DBPASSWORD MURA_DATABASE
  if _opt2_sqlserver_ready; then
    tooling_record sqlserver reused
    return 0
  fi
  # Prefix assignments reach the server's environment, keeping the SA password out of its argv.
  pid="$(ACCEPT_EULA=Y MSSQL_PID=Express MSSQL_SA_PASSWORD="$MURA_DBPASSWORD" \
    start_background sqlservr "${OPT2_SQLSERVR_CMD:-/opt/mssql/bin/sqlservr}")" || exit 1
  _opt2_await_tool sqlserver "$pid" 120 _opt2_sqlserver_ready
  tooling_record sqlserver started "$pid"
}

# Stops every tool tooling.json records as started, except SQL Server, which is never stopped; Mailpit is never managed.
stop_started_tooling() {
  local file="$OPT2_STATE_DIR/tooling.json" entries name state pid
  [[ -f $file ]] || return 0
  # shellcheck disable=SC2016 # JavaScript source
  entries="$(node -e '
const doc = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
for (const [name, entry] of Object.entries(doc)) {
  const pid = Number.isInteger(entry?.pid) ? String(entry.pid) : "";
  process.stdout.write(`${name}\t${String(entry?.state)}\t${pid}\n`);
}
' -- "$file")" || die "cannot read $file"
  while IFS=$'\t' read -r name state pid; do
    [[ $state == started && $name != sqlserver ]] || continue
    case $name in
      postgres)
        require_env PG_HOST PG_PORT
        _opt2_pg_ready || continue
        if [[ -n ${OPT2_PG_STOP_CMD:-} ]]; then
          bash -c "$OPT2_PG_STOP_CMD" || die "OPT2_PG_STOP_CMD failed"
        else
          pg_ctlcluster 16 main stop || die "pg_ctlcluster 16 main stop failed"
        fi
        ;;
      *)
        if [[ -n $pid ]]; then stop_process "$pid"; fi
        ;;
    esac
  done <<<"$entries"
}
