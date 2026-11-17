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

# UTC time to the millisecond, cut from %N: uutils date drops the leading zeros of %3N.
now_iso() {
  local t
  t="$(date -u +%Y-%m-%dT%H:%M:%S.%N)" || return
  printf '%sZ\n' "${t:0:23}"
}

# _opt2_proc_stat <pid> <field>: prints field <field> (1-based) of /proc/<pid>/stat; fails once <pid> is gone.
_opt2_proc_stat() {
  local stat
  local -a fields=()
  read -r stat 2>/dev/null <"/proc/$1/stat" || return 1
  # comm, field 2, may hold spaces and ')', so the fields after the last ')' start at field 3.
  read -r -a fields <<<"${stat##*)}"
  [[ -n ${fields[$2 - 3]:-} ]] || return 1
  printf '%s\n' "${fields[$2 - 3]}"
}

# Prints the start time of <pid> in clock ticks after boot (field 22 of /proc/<pid>/stat); fails once it is gone.
_opt2_proc_start_time() {
  local start
  start="$(_opt2_proc_stat "$1" 22)" || return 1
  [[ $start =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$start"
}

# _opt2_proc_start_matches <pid> <start-time>: true when <start-time> is empty or is <pid>'s start time, so a recorded
# pid the kernel has since given to another process does not count as the recorded one.
_opt2_proc_start_matches() {
  [[ -z ${2:-} || $(_opt2_proc_start_time "$1") == "$2" ]]
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
: "${OPT2_TOOL_PORT_PUBSUB_EMULATOR:=8085}" "${OPT2_TOOL_PORT_OTLP_HTTP:=4319}" \
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
# comma-separated list (default 200).
wait_http() {
  local url=${1:?wait_http needs a url} timeout=${2:?wait_http needs a timeout} expect=${3:-200} code deadline
  deadline=$((SECONDS + timeout))
  while true; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null)" || true
    if [[ ",$expect," == *",$code,"* ]]; then
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

# confirm_pin_preflight [pin-file]: confirms with git and node alone that the commit of the pin record (default
# opt2/source-pin.json) exists, has the recorded subject and no tracked file changed or gone; dies naming each failure.
confirm_pin_preflight() {
  local pin=${1:-$REPO/opt2/source-pin.json} sha subject found diff path limit=20
  local -a pin_failures=() changed=()
  sha="$(json_get "$pin" sha)" || die "cannot read sha from the source pin $pin"
  subject="$(json_get "$pin" subject)" || die "cannot read subject from the source pin $pin"
  [[ $sha =~ ^[0-9a-f]{40}$ ]] || die "the source pin $pin has sha '$sha', not a 40-character lowercase hex commit id"
  git -C "$REPO" cat-file -e "$sha^{commit}" 2>/dev/null ||
    die "source pin $sha not confirmed: the commit does not exist in $REPO; fetch the full history of the repository"
  found="$(git -C "$REPO" log -1 --format=%s "$sha")" || die "git log $sha failed in $REPO"
  [[ $found == "$subject" ]] || pin_failures+=("commit $sha has subject '$found'; the source pin $pin records '$subject'")
  diff="$(git -C "$REPO" diff --name-only --diff-filter=DMRT "$sha")" || die "git diff against $sha failed in $REPO"
  if [[ -n $diff ]]; then mapfile -t changed <<<"$diff"; fi
  if ((${#changed[@]} > 0)); then
    pin_failures+=("${#changed[@]} file(s) tracked at the pin changed or gone; restore each (git checkout $sha -- <path>):")
    for path in "${changed[@]:0:limit}"; do pin_failures+=("  $path"); done
    if ((${#changed[@]} > limit)); then
      pin_failures+=("  ... and $((${#changed[@]} - limit)) more (git diff --name-only --diff-filter=DMRT $sha)")
    fi
  fi
  ((${#pin_failures[@]} > 0)) || return 0
  printf 'opt2: %s\n' "${pin_failures[@]}" >&2
  die "source pin $sha not confirmed (failed checks above)"
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

# Loads the env block of the captured legacy server's own server.json: names in file order into
# CAPTURED_SERVER_ENV_NAMES, values into CAPTURED_SERVER_ENV, the file into CAPTURED_SERVER_CONFIG. Identifier names
# with scalar values only; all empty when no server.json was captured. Dies naming only the file, never a value.
load_captured_server_env() {
  local capture="$OPT2_PRISTINE_DIR/server-capture.json" config pairs name value
  CAPTURED_SERVER_ENV_NAMES=()
  CAPTURED_SERVER_CONFIG=""
  declare -gA CAPTURED_SERVER_ENV=()
  [[ -f $capture ]] || return 0
  config="$(json_get "$capture" serverConfigFile 2>/dev/null)" || config=""
  [[ -n $config && $config != null && -f $config ]] || return 0
  ensure_state_dirs
  pairs="$(mktemp -- "$OPT2_STATE_DIR/secrets/.server-env.XXXXXX")" || die "cannot create a temp file in $OPT2_STATE_DIR/secrets"
  # NUL-separated pairs, so values arrive unchanged.
  # shellcheck disable=SC2016 # JavaScript source
  if ! node -e '
const fs = require("fs");
let doc;
try { doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8").replace(/^\uFEFF/, "")); } catch {
  process.stderr.write(`opt2: ${process.argv[1]} is not valid JSON\n`);
  process.exit(1);
}
const env = doc?.env;
if (env === null || typeof env !== "object" || Array.isArray(env)) process.exit(0);
for (const [name, value] of Object.entries(env)) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value === null || typeof value === "object") continue;
  const text = String(value);
  if (!text.includes("\0")) process.stdout.write(`${name}\0${text}\0`);
}
' -- "$config" >"$pairs"; then
    rm -f -- "$pairs"
    die "cannot read the env block of $config"
  fi
  while IFS= read -r -d '' name && IFS= read -r -d '' value; do
    CAPTURED_SERVER_ENV_NAMES+=("$name")
    CAPTURED_SERVER_ENV[$name]=$value
  done <"$pairs"
  rm -f -- "$pairs"
  CAPTURED_SERVER_CONFIG=$config
}

# Exports the MURA_* and TZ entries of the captured server's env block over the inherited values, as CommandBox applies
# that block to ColdFusion, so every step and process uses legacy's own settings; names the keys on stderr, never values.
adopt_captured_server_env() {
  local name note=""
  load_captured_server_env
  for name in "${CAPTURED_SERVER_ENV_NAMES[@]}"; do
    [[ $name == MURA_* || $name == TZ ]] || continue
    note+=", $name"
    if [[ -v $name && ${!name} != "${CAPTURED_SERVER_ENV[$name]}" ]]; then note+=" (overrides the inherited value)"; fi
    export "$name=${CAPTURED_SERVER_ENV[$name]}"
  done
  if [[ -n $note ]]; then printf 'opt2: adopted from the env block of %s: %s\n' "$CAPTURED_SERVER_CONFIG" "${note#, }" >&2; fi
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

# Prints the server home LEGACY_SERVER_NAME runs on: OPT2_CF_SERVER_HOME, else the serverHomeDirectory of
# server-capture.json; empty when unknown.
legacy_server_home() {
  local home=${OPT2_CF_SERVER_HOME:-} capture="$OPT2_PRISTINE_DIR/server-capture.json"
  if [[ -z $home && -f $capture ]]; then
    home="$(json_get "$capture" serverHomeDirectory 2>/dev/null)" || home=""
    if [[ $home == null ]]; then home=""; fi
  fi
  printf '%s\n' "$home"
}

# Prints `<id>\t<status>\t<webroot>\t<serverHomeDirectory>` of the CommandBox server LEGACY_SERVER_NAME, status
# lower-cased; nothing when no server of that name is registered.
legacy_registration() {
  local info
  # `box server info` exits 0 with no output for an unknown name, so the reported name decides.
  info="$(box server info name="$LEGACY_SERVER_NAME" --json </dev/null 2>/dev/null)" ||
    die "box server info name=$LEGACY_SERVER_NAME failed"
  # shellcheck disable=SC2016 # JavaScript source
  printf '%s' "$info" | node -e '
const text = require("fs").readFileSync(0, "utf8");
// Tolerates banner lines CommandBox may print before the JSON object.
const lines = text.split("\n");
const start = lines.findIndex((line) => line.trimStart().startsWith("{"));
let info;
try { info = start < 0 ? undefined : JSON.parse(lines.slice(start).join("\n")); } catch { info = undefined; }
if (String(info?.name ?? "").toLowerCase() === process.argv[1].toLowerCase()) {
  const str = (value) => (typeof value === "string" ? value : "");
  const status = String(info.status ?? "unknown").toLowerCase();
  process.stdout.write(`${[str(info.id), status, str(info.webroot), str(info.serverHomeDirectory)].join("\t")}\n`);
}
' -- "$LEGACY_SERVER_NAME"
}

# legacy_registration_field <record> <id|status|webroot|home>: prints that field of a legacy_registration record.
legacy_registration_field() {
  local -a columns=()
  # mapfile keeps empty fields, which `read` would merge since a tab is IFS whitespace.
  mapfile -t -d $'\t' columns < <(printf '%s' "${1:-}")
  case ${2:-} in
    id) printf '%s\n' "${columns[0]:-}" ;;
    status) printf '%s\n' "${columns[1]:-}" ;;
    webroot) printf '%s\n' "${columns[2]:-}" ;;
    home) printf '%s\n' "${columns[3]:-}" ;;
    *) die "legacy_registration_field: unknown field '${2:-}'" ;;
  esac
}

# True when CommandBox registers LEGACY_SERVER_NAME with this checkout as webroot and legacy_server_home as home.
legacy_server_ours() {
  local record
  record="$(legacy_registration)" || exit 1
  legacy_record_ours "$record"
}

# legacy_record_ours <record>: legacy_server_ours for a legacy_registration record already read.
legacy_record_ours() {
  local webroot
  webroot="$(legacy_registration_field "${1:-}" webroot)"
  [[ -n $webroot && "$(realpath -m -- "$webroot")" == "$REPO" ]] && legacy_record_home_ours "${1:-}"
}

# legacy_record_home_ours <record>: true when a legacy_registration record's server home is legacy_server_home.
legacy_record_home_ours() {
  local ours home
  ours="$(legacy_server_home)"
  home="$(legacy_registration_field "${1:-}" home)"
  [[ -n $ours && -n $home && "$(realpath -m -- "$home")" == "$(realpath -m -- "$ours")" ]]
}

# Prints the CFML template legacy_unregister runs: deletes servers.json entry $id named $name under the file lock
# CommandBox takes for its own registry writes, with no ServerService call inside since that lock is JVM-wide.
_opt2_unregister_cfml() {
  cat <<'CFML'
<cfscript>
id = variables.$id;
name = variables.$name;
path = getInstance( "HomeDir@constants" ) & "/servers.json";
option = createObject( "java", "java.nio.file.StandardOpenOption" );
channel = createObject( "java", "java.nio.channels.FileChannel" ).open(
  createObject( "java", "java.io.File" ).init( path ).toPath(), [ option.READ, option.WRITE ] );
try {
  fileLock = channel.lock();
  bytes = createObject( "java", "java.io.ByteArrayOutputStream" ).init();
  buffer = createObject( "java", "java.nio.ByteBuffer" ).allocate( 65536 );
  while ( channel.read( buffer ) > 0 ) { buffer.flip(); bytes.write( buffer.array(), 0, buffer.limit() ); buffer.clear(); }
  text = bytes.toString( "UTF-8" );
  servers = deserializeJSON( text );
  if ( !structKeyExists( servers, id ) ) {
    writeOutput( "absent" );
  } else {
    if ( servers[ id ].name != name ) throw( message = "registry entry #id# is server #servers[ id ].name#, not #name#" );
    structDelete( servers, id );
    // Key order and line ending as JSONService.writeJSONFile decides them for CommandBox's own registry writes.
    config = getInstance( "ConfigService" );
    sortKeys = config.getSetting( "JSON.sortKeys", "textnocase" );
    if ( !config.settingExists( "JSON.sortKeys" ) && !getInstance( "JSONService" ).isSortedJSON( text, sortKeys ) ) sortKeys = "";
    json = getInstance( "Formatter" ).formatJson( json = servers, sortKeys = sortKeys );
    if ( !len( text ) || right( text, 1 ) == chr( 10 ) ) json &= config.getSetting( "JSON.lineEnding", server.separator.line );
    channel.truncate( 0 );
    channel.write( createObject( "java", "java.nio.ByteBuffer" ).wrap( json.getBytes( "UTF-8" ) ), 0 );
    channel.force( true );
    writeOutput( "removed" );
  }
} finally {
  if ( !isNull( fileLock ) && fileLock.isValid() ) fileLock.release();
  channel.close();
}
</cfscript>
CFML
}

# legacy_unregister <id>: removes the CommandBox registry entry <id> of LEGACY_SERVER_NAME and keeps every server file,
# which `box server forget` would delete with the server home; prints `removed`, or `absent` when no such entry exists.
legacy_unregister() {
  local id=${1:-} dir="$OPT2_STATE_DIR/commandbox" template out status=0 result
  [[ $id =~ ^[0-9A-Fa-f]{32}$ ]] || die "legacy_unregister: '$id' is not a CommandBox server id"
  ensure_state_dirs
  # The repository root is the web root, so the template lives outside it, mode 0600, for this call only.
  template="$(mktemp --suffix=.cfm -- "$dir/unregister.XXXXXX")" || die "cannot create a temp file in $dir"
  out="$(
    trap 'rm -f -- "$template"' EXIT
    _opt2_unregister_cfml >"$template" || {
      printf 'cannot write %s\n' "$template"
      exit 1
    }
    box execute file="$template" id="$id" name="$LEGACY_SERVER_NAME" </dev/null 2>&1
  )" || status=$?
  rm -f -- "$template"
  ((status == 0)) || die "cannot remove CommandBox registry entry $id of $LEGACY_SERVER_NAME (exit $status): $out"
  case $out in
    *removed*) result=removed ;;
    *absent*) result=absent ;;
    *) die "removing CommandBox registry entry $id of $LEGACY_SERVER_NAME printed neither removed nor absent: $out" ;;
  esac
  out="$(legacy_registration)" || exit 1
  if [[ "$(legacy_registration_field "$out" id)" == "$id" ]]; then
    die "CommandBox still reports registry entry $id of $LEGACY_SERVER_NAME after its removal"
  fi
  printf '%s\n' "$result"
}

# cfconfig_target [from|to]: prints the CFConfig target, one argument per line, for that direction (default from):
# LEGACY_SERVER_NAME when it is this checkout's (legacy_server_ours), else the captured server's target followed by
# `<dir>Format=<format>`.
cfconfig_target() {
  local dir=${1:-from} capture="$OPT2_PRISTINE_DIR/server-capture.json" target format
  [[ $dir == from || $dir == to ]] || die "cfconfig_target direction must be from or to, got '$dir'"
  if legacy_server_ours; then
    printf '%s\n' "$LEGACY_SERVER_NAME"
    return 0
  fi
  [[ -f $capture ]] ||
    die "no CommandBox server $LEGACY_SERVER_NAME of this checkout and no $capture: run up.sh to capture the legacy server"
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
