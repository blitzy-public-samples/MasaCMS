# shellcheck shell=bash
# Shared paths, state directories, ports, CLI handles and helpers sourced by every harness/repro script.

# A parent may have exported OPT2_COMMON_SH_LOADED; only a shell that already holds the functions skips them.
if [[ -n ${OPT2_COMMON_SH_LOADED:-} ]] && declare -F opt2_cli >/dev/null; then
  return 0
fi
OPT2_COMMON_SH_LOADED=1

# Prints `opt2: <msg>` to stderr and exits 1.
die() {
  printf 'opt2: %s\n' "$*" >&2
  exit 1
}

# Prints `==> [<UTC time>] step <n>: <title>` to stderr, keeping stdout free for JSON.
log_step() {
  printf '==> [%s] step %s: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${1:-?}" "${*:2}" >&2
}

# --- Paths and state directories -------------------------------------------------------------------------------

REPO="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd -P)" ||
  die "cannot resolve the checkout root from ${BASH_SOURCE[0]}"
REPRO_DIR="$REPO/harness/repro"
# shellcheck disable=SC2034 # used by the scripts that source this file
LIB_DIR="$REPRO_DIR/lib"

OPT2_STATE_DIR="${OPT2_STATE_DIR:-${HOME:?HOME is not set}/.opt2/state}"
OPT2_PRISTINE_DIR="${OPT2_PRISTINE_DIR:-${HOME:?HOME is not set}/.opt2/pristine}"
export OPT2_STATE_DIR OPT2_PRISTINE_DIR

# Dies unless the directory held by the variable named $1 is absolute and resolves outside the checkout.
_opt2_assert_outside_repo() {
  local name=$1 dir=${!1:-} resolved
  [[ $dir == /* ]] || die "$name must be an absolute path, got '$dir'"
  resolved="$(realpath -m -- "$dir")" || die "cannot resolve $name ($dir)"
  if [[ $resolved == "$REPO" || $resolved == "$REPO"/* ]]; then
    die "$name ($dir) resolves inside the checkout $REPO; choose a directory outside it"
  fi
}
_opt2_assert_outside_repo OPT2_STATE_DIR
_opt2_assert_outside_repo OPT2_PRISTINE_DIR

# Process output lives here rather than under a `logs` directory, which the root .gitignore ignores at any depth.
PROCESS_OUTPUT_DIR="$OPT2_STATE_DIR/process-output"
# CommandBox server name of the one OPT-2 legacy stack the run lock allows.
LEGACY_SERVER_NAME=opt2-legacy
# Untracked environment paths clean-checkout-proof.sh copies into a fresh clone; gitignored or setup-provided.
# shellcheck disable=SC2034 # used by clean-checkout-proof.sh
OPT2_ENV_ARTEFACTS=(core/vendor/testbox core/vendor/docbox themes/default config/settings.ini.cfm)

# Creates the state, process-output, commandbox, secrets and pristine directories with mode 0700.
ensure_state_dirs() {
  local dir
  for dir in "$OPT2_STATE_DIR" "$PROCESS_OUTPUT_DIR" "$OPT2_STATE_DIR/commandbox" "$OPT2_STATE_DIR/secrets" \
    "$OPT2_PRISTINE_DIR"; do
    mkdir -p -- "$dir"
    chmod 0700 -- "$dir"
  done
}

# --- Ports -----------------------------------------------------------------------------------------------------

[[ -f $REPRO_DIR/ports.env ]] || die "missing $REPRO_DIR/ports.env"
# allexport exports every OPT2_PORT_* and OPT2_TOOL_PORT_* key; the caller's allexport state is kept.
if [[ $- == *a* ]]; then
  # shellcheck source=SCRIPTDIR/../ports.env
  source "$REPRO_DIR/ports.env"
else
  set -a
  # shellcheck source=SCRIPTDIR/../ports.env
  source "$REPRO_DIR/ports.env"
  set +a
fi
: "${OPT2_TOOL_PORT_PUBSUB_EMULATOR:=8085}" "${OPT2_TOOL_PORT_OTLP_HTTP:=4318}" \
  "${OPT2_TOOL_PORT_MAILPIT_SMTP:=1025}" "${OPT2_TOOL_PORT_MAILPIT_HTTP:=8025}"
export OPT2_TOOL_PORT_PUBSUB_EMULATOR OPT2_TOOL_PORT_OTLP_HTTP OPT2_TOOL_PORT_MAILPIT_SMTP OPT2_TOOL_PORT_MAILPIT_HTTP

# The migration service runs legacy-start.sh with its own PORT, so processes.sh hands legacy's over as OPT2_LEGACY_PORT.
LEGACY_PORT="${OPT2_LEGACY_PORT:-${PORT:-}}"

# Prints legacy ColdFusion's loopback origin.
legacy_origin() {
  [[ -n ${LEGACY_PORT:-} ]] || die "legacy port unknown: set PORT (or OPT2_LEGACY_PORT)"
  printf 'http://127.0.0.1:%s\n' "$LEGACY_PORT"
}

# shellcheck disable=SC2034 # used by the scripts that source this file
{
  OPT2_GATEWAY_ORIGIN_LOCAL="http://127.0.0.1:${OPT2_PORT_GATEWAY:?OPT2_PORT_GATEWAY is missing from ports.env}"
  OPT2_MIGRATION_ORIGIN_LOCAL="http://127.0.0.1:${OPT2_PORT_MIGRATION:?OPT2_PORT_MIGRATION is missing from ports.env}"
  MAILPIT_API_LOCAL="http://127.0.0.1:${OPT2_TOOL_PORT_MAILPIT_HTTP}"
}

# --- CLI handles -----------------------------------------------------------------------------------------------
# Compiled scripts run through node: a package's own bins are not linked into its node_modules/.bin, and tsc
# output is not executable.

# Dies unless the compiled script $1 exists.
_opt2_require_built() {
  [[ -f $1 ]] || die "$1 is missing: run up.sh step 3 build first"
}

# Runs a compiled OPT-2 CLI: under operator_env (processes.sh) when defined, else in the current environment.
opt2_cli() {
  local script=${1:?opt2_cli needs a script} env_text
  local -a env_lines=()
  shift
  _opt2_require_built "$script"
  if declare -F operator_env >/dev/null; then
    env_text="$(operator_env)" || die "operator_env failed"
    mapfile -t env_lines < <(printf '%s' "$env_text")
    env -i PATH="$PATH" HOME="$HOME" "${env_lines[@]}" node "$script" "$@"
  else
    node "$script" "$@"
  fi
}

# opt2-migrate.
opt2_migrate() { opt2_cli "$REPO/migration/dist/cli.js" "$@"; }
# opt2-ops.
opt2_ops() { opt2_cli "$REPO/migration/dist/quiesce/cli.js" "$@"; }
# opt2-db, in the caller's environment: the local bootstrap is the one user of the admin PG_USER.
opt2_db() {
  _opt2_require_built "$REPO/migration/dist/db-bootstrap/cli.js"
  node "$REPO/migration/dist/db-bootstrap/cli.js" "$@"
}
# opt2-tasks.
opt2_tasks() { opt2_cli "$REPO/platform/dist/tasks/cli.js" "$@"; }
# opt2-outbox.
opt2_outbox() { opt2_cli "$REPO/platform/dist/outbox/cli.js" "$@"; }
# opt2-events.
opt2_events() { opt2_cli "$REPO/platform/dist/events/cli.js" "$@"; }
# opt2-auth.
opt2_auth() { opt2_cli "$REPO/platform/dist/auth/cli.js" "$@"; }
# An npm script of the harness package, in the caller's environment.
harness_run() { npm --prefix "$REPO/harness" run --silent "$@"; }

# Each handle names a function, so both `$MIGRATE …` and `"$MIGRATE" …` call it.
# shellcheck disable=SC2034
{
  MIGRATE=opt2_migrate
  OPT2_OPS=opt2_ops
  OPT2_DB=opt2_db
  OPT2_TASKS=opt2_tasks
  OPT2_OUTBOX=opt2_outbox
  OPT2_EVENTS=opt2_events
  OPT2_AUTH=opt2_auth
  HARNESS_RUN=harness_run
}

# --- Generic helpers -------------------------------------------------------------------------------------------

# Dies naming every command missing from PATH.
require_cmd() {
  local cmd
  local -a missing=()
  for cmd in "$@"; do
    command -v -- "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
  done
  ((${#missing[@]} == 0)) || die "missing commands: ${missing[*]}"
}

# Dies naming every unset or empty variable; values are never printed.
require_env() {
  local name
  local -a missing=()
  for name in "$@"; do
    [[ -n ${!name:-} ]] || missing+=("$name")
  done
  ((${#missing[@]} == 0)) || die "missing environment variables: ${missing[*]}"
}

# wait_http <url> <timeout-s> [expect]: polls every 2 s until the status matches expect, a status or a
# comma-separated list (default 200), or for `any`, any HTTP answer.
wait_http() {
  local url=${1:?wait_http needs a url} timeout=${2:?wait_http needs a timeout} expect=${3:-200} code deadline
  deadline=$((SECONDS + timeout))
  while true; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null)" || true
    if [[ $expect == any ]]; then
      if [[ -n $code && $code != 000 ]]; then return 0; fi
    elif [[ ",$expect," == *",$code,"* ]]; then
      return 0
    fi
    ((SECONDS < deadline)) || die "$url did not answer $expect within ${timeout}s (last status ${code:-none})"
    sleep 2
  done
}

# True when 127.0.0.1:<port> accepts a connection, or ss reports a listener on the port.
_opt2_port_open() {
  local port=$1
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    return 0
  fi
  command -v ss >/dev/null 2>&1 && [[ -n "$(ss -Hltn "sport = :$port" 2>/dev/null)" ]]
}

# Waits up to <timeout-s> seconds for the port to accept connections.
wait_port_open() {
  local port=${1:?wait_port_open needs a port} timeout=${2:?wait_port_open needs a timeout} deadline
  deadline=$((SECONDS + timeout))
  until _opt2_port_open "$port"; do
    ((SECONDS < deadline)) || die "port $port did not open within ${timeout}s"
    sleep 1
  done
}

# Waits up to <timeout-s> seconds for the port to stop accepting connections.
wait_port_closed() {
  local port=${1:?wait_port_closed needs a port} timeout=${2:?wait_port_closed needs a timeout} deadline
  deadline=$((SECONDS + timeout))
  while _opt2_port_open "$port"; do
    ((SECONDS < deadline)) || die "port $port is still open after ${timeout}s"
    sleep 1
  done
}

# Dies when the port is already in use.
assert_port_free() {
  if _opt2_port_open "${1:?assert_port_free needs a port}"; then
    die "port $1 already in use"
  fi
}

# json_get <file|-> <path>: prints the value at the dotted path (numeric array indices; empty = whole document).
# Input that is not one JSON document falls back to its last non-empty line that parses. Scalars print raw,
# objects and arrays as compact JSON; exits 1 when the path is absent.
json_get() {
  # shellcheck disable=SC2016 # JavaScript source
  node -e '
const fs = require("fs");
const [src, path] = process.argv.slice(1);
const fail = (message) => { process.stderr.write(`json_get: ${message}\n`); process.exit(1); };
let text;
try { text = fs.readFileSync(src === "-" ? 0 : src, "utf8"); } catch (err) { fail(`cannot read ${src}: ${err.message}`); }
const parse = (s) => { try { return { ok: true, value: JSON.parse(s) }; } catch { return { ok: false }; } };
let doc = parse(text);
for (const line of doc.ok ? [] : text.split(/\r?\n/).reverse()) {
  if (line.trim() === "") continue;
  doc = parse(line);
  if (doc.ok) break;
}
if (!doc.ok) fail("no JSON in input");
let value = doc.value;
for (const key of path === "" ? [] : path.split(".")) {
  if (Array.isArray(value) && /^\d+$/.test(key) && Number(key) < value.length) value = value[Number(key)];
  else if (value !== null && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, key)) value = value[key];
  else fail(`path ${path} not found`);
}
process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
' -- "${1:?json_get needs a file or -}" "${2:-}"
}

# Prints the local secret <name> from $OPT2_STATE_DIR/secrets without a trailing newline; dies naming only the file.
secret() {
  local file="$OPT2_STATE_DIR/secrets/${1:?secret needs a name}" value
  [[ -s $file ]] || die "secret file $file is missing or empty: run 'npm run repro:secrets' in harness/"
  value="$(<"$file")"
  printf '%s' "$value"
}

# --- Legacy SQL Server, settings and file store ----------------------------------------------------------------

# sqlcmd_legacy [--db <name>] <sqlcmd args…>: sqlcmd against the legacy server (default database MURA_DATABASE),
# headerless and trimmed, failing on SQL errors; the password travels in SQLCMDPASSWORD, never on the command line.
sqlcmd_legacy() {
  require_env MURA_DBHOST MURA_DBUSERNAME MURA_DBPASSWORD MURA_DATABASE
  local db=$MURA_DATABASE bin candidate
  local -a trust=()
  if [[ ${1:-} == --db ]]; then
    db=${2:?sqlcmd_legacy --db needs a database name}
    shift 2
  fi
  bin="$(command -v sqlcmd 2>/dev/null)" || bin=""
  for candidate in /opt/mssql-tools18/bin/sqlcmd /opt/mssql-tools/bin/sqlcmd; do
    if [[ -z $bin && -x $candidate ]]; then bin=$candidate; fi
  done
  [[ -n $bin ]] || die "sqlcmd not found on PATH, in /opt/mssql-tools18/bin or /opt/mssql-tools/bin"
  # Trust defaults on, as OPT2_MSSQL_TRUST_SERVER_CERT does for the migration service: the local SQL Server presents
  # a self-signed certificate that ODBC Driver 18 otherwise rejects. Only false or 0 turns it off.
  case ${OPT2_MSSQL_TRUST_SERVER_CERT:-true} in
    false | 0) ;;
    *) trust=(-C) ;;
  esac
  SQLCMDPASSWORD="$MURA_DBPASSWORD" "$bin" -S "${MURA_DBHOST},${MURA_DBPORT:-1433}" -U "$MURA_DBUSERNAME" -d "$db" \
    -b -h -1 -W "${trust[@]}" "$@"
}

# Prints a Masa setting as Masa resolves it, empty when absent: MURA_<KEY> when set, else the key in the section
# named by `mode` (default production), else in [settings] of config/settings.ini.cfm. Keys are case-insensitive.
masa_setting() {
  local key=${1:?masa_setting needs a key} env_name ini="$REPO/config/settings.ini.cfm"
  env_name="MURA_${key^^}"
  if [[ -v $env_name ]]; then
    printf '%s\n' "${!env_name}"
    return 0
  fi
  [[ -f $ini ]] || return 0
  # Masa reads [settings] first and lets the mode section overwrite it, so the mode section wins.
  KEY="$key" MODE="${MURA_MODE:-}" awk '
    BEGIN { want = tolower(ENVIRON["KEY"]) }
    { sub(/\r$/, "") }
    /^[ \t]*[;#]/ { next }
    /^[ \t]*\[[^]]*\][ \t]*$/ { sec = $0; gsub(/^[ \t]*\[|\][ \t]*$/, "", sec); sec = tolower(sec); next }
    {
      eq = index($0, "=")
      if (eq == 0) next
      k = tolower(substr($0, 1, eq - 1)); gsub(/^[ \t]+|[ \t]+$/, "", k)
      v = substr($0, eq + 1); gsub(/^[ \t]+|[ \t]+$/, "", v)
      if (!((sec, k) in val)) val[sec, k] = v
    }
    END {
      mode = tolower(ENVIRON["MODE"])
      if (mode == "") mode = (("settings", "mode") in val && val["settings", "mode"] != "") ? tolower(val["settings", "mode"]) : "production"
      if ((mode, want) in val) print val[mode, want]
      else if (("settings", want) in val) print val["settings", want]
    }
  ' "$ini"
}

# Prints Masa's site directory: sites/ of the checkout, or the checkout itself for a root-level `default` site.
masa_site_dir() {
  if [[ ! -d $REPO/sites && -d $REPO/default ]]; then
    printf '%s\n' "$REPO"
  else
    printf '%s\n' "$REPO/sites"
  fi
}

# Prints the physical root of Masa's fileDir store, holding <siteid>/cache/file/<fileID><variant>.<ext>; dies for
# any other store.
masa_file_root() {
  local store s3 dir assets context
  store="$(masa_setting filestore)"
  if [[ -n $store && ${store,,} != filedir ]]; then
    die "non-fileDir file store ($store): file units stay legacy and are recorded halted by migration (AAP 0.8.1)"
  fi
  # s3assets embeds credentials, so only its name is reported.
  s3="$(masa_setting s3assets)"
  [[ -z $s3 ]] || die "non-fileDir file store (s3assets): file units stay legacy and are recorded halted by migration (AAP 0.8.1)"

  # Masa strips one trailing slash from fileDir, assetPath and context.
  dir="$(masa_setting filedir)"
  dir=${dir%[/\\]}
  if [[ -n $dir ]]; then
    if [[ $dir == /muraWRM || $dir == /muraWRM/* ]]; then dir="$REPO${dir#/muraWRM}"; fi
    [[ $dir == /* ]] || die "filedir '$dir' is not an absolute path"
    printf '%s\n' "$dir"
    return 0
  fi

  assets="$(masa_setting assetpath)"
  assets=${assets%[/\\]}
  context="$(masa_setting context)"
  context=${context%[/\\]}
  if [[ -n $assets && -n $context ]]; then
    # Masa removes every case-insensitive occurrence of the context from the asset path.
    assets="$(S="$assets" T="$context" awk 'BEGIN {
      s = ENVIRON["S"]; t = ENVIRON["T"]; out = ""
      while ((i = index(tolower(s), tolower(t))) > 0) { out = out substr(s, 1, i - 1); s = substr(s, i + length(t)) }
      print out s
    }')"
  fi
  if [[ -n $assets ]]; then
    printf '%s\n' "$REPO$assets"
  else
    masa_site_dir
  fi
}

# Prints the existing <siteid>/cache/file directories under the file root $1, relative to it.
_opt2_filestore_dirs() {
  local root=$1 dir
  for dir in "$root"/*/cache/file; do
    if [[ -d $dir ]]; then printf '%s\n' "${dir#"$root"/}"; fi
  done
  return 0
}

# Writes a tar of every <siteid>/cache/file tree, members relative to the file root so it restores into any checkout.
filestore_tar() {
  local out=${1:?filestore_tar needs an output file} root
  local -a dirs=()
  out="$(realpath -m -- "$out")"
  root="$(masa_file_root)" || exit 1
  mapfile -t dirs < <(_opt2_filestore_dirs "$root")
  if ((${#dirs[@]} == 0)); then
    tar -cf "$out" --files-from=/dev/null
  else
    tar -C "$root" -cf "$out" -- "${dirs[@]}"
  fi
}

# Empties every existing <siteid>/cache/file directory, then extracts <tar> into the file root, keeping modes.
filestore_extract() {
  local tarball=${1:?filestore_extract needs a tar file} root dir
  [[ -f $tarball ]] || die "file-store tar $tarball does not exist"
  tarball="$(realpath -- "$tarball")"
  tar -tf "$tarball" >/dev/null || die "file-store tar $tarball is unreadable"
  root="$(masa_file_root)" || exit 1
  while IFS= read -r dir; do
    find "$root/$dir" -mindepth 1 -delete
  done < <(_opt2_filestore_dirs "$root")
  tar -C "$root" -xpf "$tarball"
}

# filestore_manifest [root]: prints sorted `<sha256>  <siteid>/cache/file/…` lines for every file of the store.
filestore_manifest() {
  local root=${1:-}
  local -a dirs=()
  if [[ -z $root ]]; then root="$(masa_file_root)" || exit 1; fi
  mapfile -t dirs < <(_opt2_filestore_dirs "$root")
  ((${#dirs[@]} > 0)) || return 0
  (cd -- "$root" && find "${dirs[@]}" -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum)
}

# Prints every content.* unit of opt2/table-ownership.json, sorted and comma-joined: the start-up window's units.
content_units() {
  local file="$REPO/opt2/table-ownership.json" units
  # The unit id is each units[] entry's `unit` field.
  units="$(node -e '
const doc = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const ids = (doc.units ?? []).map((u) => u.unit).filter((id) => typeof id === "string" && id.startsWith("content."));
process.stdout.write(ids.sort().join(","));
' -- "$file")" || die "cannot read the units of $file"
  [[ -n $units ]] || die "no content.* units in $file"
  printf '%s\n' "$units"
}

# --- CommandBox and CFConfig -----------------------------------------------------------------------------------

# True when CommandBox has a server registered under <name> (default LEGACY_SERVER_NAME).
cf_server_registered() {
  local name=${1:-$LEGACY_SERVER_NAME} info found
  command -v box >/dev/null 2>&1 || return 1
  # `box server info` exits 0 with no output for an unknown name, so the reported name decides.
  info="$(box server info name="$name" --json 2>/dev/null)" || return 1
  found="$(printf '%s' "$info" | json_get - name 2>/dev/null)" || return 1
  [[ ${found,,} == "${name,,}" ]]
}

# cfconfig_target [from|to]: prints the CFConfig target, one argument per line, for that direction (default from):
# LEGACY_SERVER_NAME when registered, else the captured server's target followed by `<dir>Format=<format>`.
cfconfig_target() {
  local dir=${1:-from} capture="$OPT2_PRISTINE_DIR/server-capture.json" target format
  [[ $dir == from || $dir == to ]] || die "cfconfig_target direction must be from or to, got '$dir'"
  if cf_server_registered; then
    printf '%s\n' "$LEGACY_SERVER_NAME"
    return 0
  fi
  [[ -f $capture ]] || die "no CommandBox server $LEGACY_SERVER_NAME and no $capture: run up.sh to capture the legacy server"
  target="$(json_get "$capture" cfconfigTarget 2>/dev/null)" || target=""
  [[ -n $target && $target != null ]] || die "$capture has no cfconfigTarget"
  format="$(json_get "$capture" cfconfigFormat 2>/dev/null)" || format=""
  printf '%s\n' "$target"
  if [[ -n $format && $format != null ]]; then printf '%sFormat=%s\n' "$dir" "$format"; fi
}

# _opt2_cfconfig_endpoint <from|to> [target [format]]: prints `<dir>=<target>` and any `<dir>Format=<format>`;
# without a target, cfconfig_target decides.
_opt2_cfconfig_endpoint() {
  local dir=$1 target=${2:-} format=${3:-} capture="$OPT2_PRISTINE_DIR/server-capture.json" lines
  if [[ -z $target ]]; then
    lines="$(cfconfig_target "$dir")" || exit 1
    printf '%s=%s\n' "$dir" "${lines%%$'\n'*}"
    if [[ $lines == *$'\n'* ]]; then printf '%s\n' "${lines#*$'\n'}"; fi
    return 0
  fi
  printf '%s=%s\n' "$dir" "$target"
  # A server-home path, unlike a CommandBox server name, needs the engine format.
  if [[ -z $format && $target == /* && -f $capture ]]; then
    format="$(json_get "$capture" cfconfigFormat 2>/dev/null)" || format=""
  fi
  if [[ -n $format && $format != null ]]; then printf '%sFormat=%s\n' "$dir" "$format"; fi
}

# cfconfig_export <out.json> [target [format]]: exports the target's scheduled tasks to a CFConfig JSON file.
cfconfig_export() {
  local out=${1:?cfconfig_export needs an output file} endpoint
  local -a from=()
  out="$(realpath -m -- "$out")"
  endpoint="$(_opt2_cfconfig_endpoint from "${@:2}")" || exit 1
  mapfile -t from < <(printf '%s\n' "$endpoint")
  box cfconfig export "${from[@]}" to="$out" includeList=scheduledTasks
}

# cfconfig_import <in.json> [target [format]]: makes the file the target's complete scheduled-task set; without
# --append CFConfig replaces the whole scheduledTasks collection.
cfconfig_import() {
  local file=${1:?cfconfig_import needs a CFConfig file} endpoint
  local -a to=()
  [[ -f $file ]] || die "CFConfig file $file does not exist"
  file="$(realpath -- "$file")"
  endpoint="$(_opt2_cfconfig_endpoint to "${@:2}")" || exit 1
  mapfile -t to < <(printf '%s\n' "$endpoint")
  box cfconfig import from="$file" "${to[@]}" includeList=scheduledTasks
}
