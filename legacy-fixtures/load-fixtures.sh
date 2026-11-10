#!/usr/bin/env bash
# SYNTHETIC: legacy-fixtures - no Masa equivalent; legacy oracle in legacy-fixtures/
# Checks what the legacy fixtures need, loads legacy-fixtures/sql into the legacy database and records ${OPT2_STATE_DIR}/fixtures.json.
# -E lets the ERR trap cover failures inside functions as well.
set -Eeuo pipefail

MURA_DBHOST="${MURA_DBHOST:-127.0.0.1}"
MURA_DBPORT="${MURA_DBPORT:-1433}"
MURA_DATABASE="${MURA_DATABASE:-}"
MURA_DBUSERNAME="${MURA_DBUSERNAME:-}"
MURA_DBPASSWORD="${MURA_DBPASSWORD:-}"
OPT2_STATE_DIR="${OPT2_STATE_DIR:-$HOME/.opt2/state}"
MAILPIT_API_URL="${MAILPIT_API_URL:-http://127.0.0.1:8025}"
SMTP_HOST="${SMTP_HOST:-127.0.0.1}"
SMTP_PORT="${SMTP_PORT:-1025}"
OPT2_LEGACY_SERVER_NAME="${OPT2_LEGACY_SERVER_NAME:-opt2-legacy}"

REQUIRED_CFPM_PACKAGES=(spreadsheet document mail scheduler)
STATUS_FILE="$OPT2_STATE_DIR/fixtures.json"
WORK_DIR="$OPT2_STATE_DIR/fixtures"
SQLCMD_OUT="$WORK_DIR/sqlcmd.out"

STEP="setup"
SQLCMD_BIN=""
SQLCMD_ARGS=()
SQL_ERROR=""
SCALAR=""
JOINED=""
REASONS=()
PROGRAMS=()
PROGRAMS_READ=0
CFPM_INSTALLED=()

# Writes fixtures.json atomically: write_status <true|false> <reason>.
write_status() {
  local tmp
  tmp="$(mktemp "$OPT2_STATE_DIR/.fixtures.json.XXXXXX")" || return 1
  if ! node -e '
    const [available, reason] = process.argv.slice(1);
    const status = { available: available === "true", reason, checkedAt: new Date().toISOString() };
    process.stdout.write(JSON.stringify(status, null, 2) + "\n");
  ' -- "$1" "$2" >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  chmod 0644 "$tmp" && mv -f "$tmp" "$STATUS_FILE"
}

# Records an unexpected error in fixtures.json and exits 1; only the main shell writes the file.
fail() {
  trap - ERR
  (( BASH_SUBSHELL == 0 )) || exit 1
  printf 'load-fixtures: error: %s: %s\n' "$STEP" "$1" >&2
  write_status false "error: $STEP: $1" || printf 'load-fixtures: could not write %s\n' "$STATUS_FILE" >&2
  exit 1
}

# Sets JOINED to the arguments after the first, separated by the first.
join_by() {
  local separator="$1" part
  shift
  JOINED="${1:-}"
  shift || true
  for part in "$@"; do JOINED+="$separator$part"; done
}

# Sets SQLCMD_BIN and SQLCMD_ARGS; returns 1 when no sqlcmd is installed.
resolve_sqlcmd() {
  local candidate help
  for candidate in "${SQLCMD:-}" "$(command -v sqlcmd || true)" /opt/mssql-tools18/bin/sqlcmd /opt/mssql-tools/bin/sqlcmd; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      SQLCMD_BIN="$candidate"
      break
    fi
  done
  [[ -n "$SQLCMD_BIN" ]] || return 1
  SQLCMD_ARGS=(-S "$MURA_DBHOST,$MURA_DBPORT" -U "$MURA_DBUSERNAME" -d "$MURA_DATABASE" -b -I)
  # The tools18 build encrypts by default, so it must trust the local server's self-signed certificate.
  if [[ "$(readlink -f "$SQLCMD_BIN" || true)" == */mssql-tools18/* ]]; then
    SQLCMD_ARGS+=(-C)
  else
    help="$("$SQLCMD_BIN" '-?' 2>&1)" || true
    if [[ "$help" =~ -C,?[[:space:]]+(Trust|--trust) ]]; then SQLCMD_ARGS+=(-C); fi
  fi
}

# Runs sqlcmd against the legacy database, the password passed only through SQLCMDPASSWORD; sets SQL_ERROR on failure.
sql() {
  local rc=0
  SQLCMDPASSWORD="$MURA_DBPASSWORD" "$SQLCMD_BIN" "${SQLCMD_ARGS[@]}" "$@" >"$SQLCMD_OUT" 2>&1 || rc=$?
  if (( rc != 0 )); then
    SQL_ERROR="$(sed -e '/^[[:space:]]*$/d' "$SQLCMD_OUT" | tail -n 1)"
    SQL_ERROR="sqlcmd exited $rc: ${SQL_ERROR:0:300}"
  fi
  return "$rc"
}

# Runs one query and sets SCALAR to its output, without trailing blanks or empty lines.
scalar() {
  sql -h -1 -W -Q "SET NOCOUNT ON; $1" || return
  SCALAR="$(sed -e 's/[[:space:]]*$//' -e '/^$/d' "$SQLCMD_OUT")"
}

# Appends a reason when the legacy database is unreachable or cannot hold the fixture schemas.
check_database() {
  if ! scalar "SELECT CASE WHEN HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE SCHEMA') = 1 OR (SCHEMA_ID('synthetic') IS NOT NULL AND SCHEMA_ID('Program_1') IS NOT NULL AND SCHEMA_ID('Program_2') IS NOT NULL) THEN 1 ELSE 0 END"; then
    REASONS+=("legacy database unreachable ($SQL_ERROR)")
  elif [[ "$SCALAR" != "1" ]]; then
    REASONS+=("no CREATE SCHEMA permission in $MURA_DATABASE")
  fi
}

# Sets CFPM_INSTALLED from cfpm list output (one "<name>, version : <version>" line per package); returns 1 when none is listed.
parse_cfpm() {
  local line
  CFPM_INSTALLED=()
  while IFS= read -r line; do
    line="${line,,}"
    if [[ "$line" =~ ^[[:space:]]*([a-z0-9_.-]+)[[:space:]]*,[[:space:]]*version ]]; then
      CFPM_INSTALLED+=("${BASH_REMATCH[1]}")
    fi
  done < <(printf '%s\n' "$1" | sed -E -e 's/\x1B\[[0-9;?]*[A-Za-z]//g' -e 's/\r$//')
  (( ${#CFPM_INSTALLED[@]} > 0 ))
}

# Sets CFPM_INSTALLED from the first listing method that works; returns 1 when none does.
read_cfpm_packages() {
  local out home
  if [[ -n "${CFPM_CMD:-}" ]] && out="$("$CFPM_CMD" list 2>&1)" && parse_cfpm "$out"; then
    return 0
  fi
  if out="$(cd "$REPO_ROOT" && box server info name="$OPT2_LEGACY_SERVER_NAME" property=serverHomeDirectory 2>/dev/null)"; then
    home="$(printf '%s\n' "$out" | sed -E -e 's/\x1B\[[0-9;?]*[A-Za-z]//g' -e 's/[[:space:]]*$//' -e '/^$/d' | tail -n 1)"
    if [[ -n "$home" && -x "$home/WEB-INF/cfusion/bin/cfpm.sh" ]] \
      && out="$("$home/WEB-INF/cfusion/bin/cfpm.sh" list 2>&1)" && parse_cfpm "$out"; then
      return 0
    fi
  fi
  out="$(cd "$REPO_ROOT" && CFPM_SERVER="$OPT2_LEGACY_SERVER_NAME" box cfpm list 2>&1)" && parse_cfpm "$out"
}

# Appends a reason when the cfpm packages behind cfspreadsheet, cfdocument, cfmail or cfschedule are missing.
check_cfpm() {
  local required installed found missing=()
  if ! read_cfpm_packages; then
    REASONS+=("cfpm package list unavailable")
    return 0
  fi
  for required in "${REQUIRED_CFPM_PACKAGES[@]}"; do
    found=0
    for installed in "${CFPM_INSTALLED[@]}"; do
      if [[ "$installed" == "$required" ]]; then found=1; fi
    done
    if (( found == 0 )); then missing+=("$required"); fi
  done
  if (( ${#missing[@]} > 0 )); then
    join_by ", " "${missing[@]}"
    REASONS+=("missing cfpm packages: $JOINED")
  fi
}

# Appends a reason when the Mailpit API or its SMTP listener does not answer within 5 s.
check_mailpit() {
  local down=()
  curl -fsS --max-time 5 "$MAILPIT_API_URL/api/v1/info" >/dev/null 2>&1 || down+=("api $MAILPIT_API_URL")
  # shellcheck disable=SC2016 # expanded by the child bash
  timeout 5 bash -c 'exec 3<>"/dev/tcp/$1/$2"' _ "$SMTP_HOST" "$SMTP_PORT" 2>/dev/null || down+=("smtp $SMTP_HOST:$SMTP_PORT")
  if (( ${#down[@]} > 0 )); then
    join_by ", " "${down[@]}"
    REASONS+=("Mailpit unavailable ($JOINED)")
  fi
}

# Sets PROGRAMS from synthetic.program_site, once.
read_programs() {
  local id
  (( PROGRAMS_READ == 0 )) || return 0
  scalar "SELECT [program_id] FROM [synthetic].[program_site] ORDER BY [program_id]" || fail "$SQL_ERROR"
  while IFS= read -r id; do
    if [[ -n "$id" ]]; then PROGRAMS+=("$id"); fi
  done <<<"$SCALAR"
  (( ${#PROGRAMS[@]} > 0 )) || fail "synthetic.program_site lists no programs"
  PROGRAMS_READ=1
}

# Runs every sql/ file in LC_ALL=C path order; a *.program.sql file runs once per program schema.
load_sql_files() {
  local listing rel id
  local -a files
  STEP="list sql"
  listing="$(cd "$SCRIPT_DIR/sql" && find . -type f -name '*.sql' -printf '%P\n' | LC_ALL=C sort)"
  mapfile -t files <<<"$listing"
  for rel in "${files[@]}"; do
    [[ -n "$rel" ]] || continue
    if [[ "$rel" == *.program.sql ]]; then
      STEP="programs"
      read_programs
      for id in "${PROGRAMS[@]}"; do
        STEP="load sql/$rel [Program_$id]"
        sql -v "PROGRAM_SCHEMA=Program_$id" "PROGRAM_ID=$id" -i "$SCRIPT_DIR/sql/$rel" || fail "$SQL_ERROR"
        printf 'loaded sql/%s [Program_%s]\n' "$rel" "$id" >&2
      done
    else
      STEP="load sql/$rel"
      sql -i "$SCRIPT_DIR/sql/$rel" || fail "$SQL_ERROR"
      printf 'loaded sql/%s\n' "$rel" >&2
    fi
  done
}

# Loads one service's state-machine export into its synthetic transition table and checks the row count.
load_transitions() {
  local service="$1" table="$2" json="$REPO_ROOT/opt2/reports/state-machines/$1.json" sql_file="$WORK_DIR/transitions-$1.sql" expected
  STEP="transitions $service"
  [[ -f "$json" ]] || fail "missing opt2/reports/state-machines/$service.json"
  # shellcheck disable=SC2016 # JavaScript template literals
  expected="$(node -e '
    const fs = require("fs");
    const [source, target, service] = process.argv.slice(1);
    const text = fs.readFileSync(source, "utf8");
    const { rows } = JSON.parse(text);
    if (!Array.isArray(rows)) throw new Error(`${source}: rows is not an array`);
    const q = "\x27";
    const literal = (value) => `N${q}${value.split(q).join(q + q)}${q}`;
    fs.writeFileSync(target, `EXEC [synthetic].[usp_load_transitions] @service = ${literal(service)}, @json = ${literal(text)};\n`);
    process.stdout.write(String(rows.length));
  ' -- "$json" "$sql_file" "$service")" || fail "could not convert opt2/reports/state-machines/$service.json"
  # -x: the export is data, so sqlcmd must not substitute $(...) inside it.
  sql -x -i "$sql_file" || fail "$SQL_ERROR"
  scalar "SELECT COUNT(*) FROM [synthetic].[$table]" || fail "$SQL_ERROR"
  [[ "$SCALAR" == "$expected" ]] || fail "synthetic.$table holds $SCALAR rows; opt2/reports/state-machines/$service.json has $expected"
  printf 'loaded opt2/reports/state-machines/%s.json into synthetic.%s (%s rows)\n' "$service" "$table" "$expected" >&2
}

trap 'fail "exit $? at line $LINENO"' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
mkdir -p "$WORK_DIR"
for name in MURA_DATABASE MURA_DBUSERNAME MURA_DBPASSWORD; do
  [[ -n "${!name}" ]] || fail "$name is not set"
done

STEP="capability checks"
if resolve_sqlcmd; then
  check_database
else
  REASONS+=("sqlcmd not found")
fi
check_cfpm
check_mailpit

if (( ${#REASONS[@]} > 0 )); then
  join_by "; " "${REASONS[@]}"
  STEP="status"
  write_status false "$JOINED"
  printf 'load-fixtures: fixtures unavailable: %s\n' "$JOINED" >&2
  exit 0
fi

load_sql_files
load_transitions finance finance_transition
load_transitions timesheets timesheet_transition

STEP="status"
write_status true "fixtures loaded"
printf 'load-fixtures: fixtures loaded\n' >&2
