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

# sqlcmd limits in seconds: login, then the whole run of one capability query or of one loading call.
SQLCMD_LOGIN_TIMEOUT=15
CHECK_DEADLINE=60
LOAD_DEADLINE=300

STEP="setup"
SQLCMD_BIN=""
SQLCMD_ARGS=()
SQL_DEADLINE="$CHECK_DEADLINE"
SQL_ERROR=""
SCALAR=""
JOINED=""
REASONS=()

# Prints the usage text.
usage() {
  cat <<'EOF'
Usage: legacy-fixtures/load-fixtures.sh [--check-only | -h | --help]

Checks what the legacy fixtures need, loads legacy-fixtures/sql into the legacy database when it is all present
and writes ${OPT2_STATE_DIR}/fixtures.json. --check-only runs the checks and writes fixtures.json, loading nothing.
Takes no other arguments; it is configured through the environment.

Required: MURA_DATABASE, MURA_DBUSERNAME, MURA_DBPASSWORD
Optional: MURA_DBHOST, MURA_DBPORT, OPT2_STATE_DIR (absolute, outside the checkout; default $HOME/.opt2/state), SQLCMD

Exit status: 0 once fixtures.json is written, 1 on an unexpected error, 2 on a usage or OPT2_STATE_DIR error.
EOF
}

# Writes fixtures.json atomically: write_status <true|false> <reason>.
write_status() {
  local tmp
  tmp="$(mktemp "$OPT2_STATE_DIR/.fixtures.json.$$.XXXXXX")" || return 1
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
  # A signal trapped inside write_status leaves its temporary file; the pid in the name spares concurrent runs.
  rm -f -- "$OPT2_STATE_DIR/.fixtures.json.$$."* || true
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

# Sets SQLCMD_BIN and SQLCMD_ARGS; returns 1 when no sqlcmd is installed and fails when a set SQLCMD is not an executable file.
resolve_sqlcmd() {
  local candidate help
  if [[ -n "${SQLCMD:-}" ]]; then
    [[ -f "$SQLCMD" && -x "$SQLCMD" ]] || fail "SQLCMD=$SQLCMD is not an executable file"
    # A bare name runs the file tested here, not a PATH lookup.
    if [[ "$SQLCMD" == */* ]]; then SQLCMD_BIN="$SQLCMD"; else SQLCMD_BIN="./$SQLCMD"; fi
  else
    for candidate in "$(command -v sqlcmd || true)" /opt/mssql-tools18/bin/sqlcmd /opt/mssql-tools/bin/sqlcmd; do
      if [[ -n "$candidate" && -x "$candidate" ]]; then
        SQLCMD_BIN="$candidate"
        break
      fi
    done
  fi
  [[ -n "$SQLCMD_BIN" ]] || return 1
  SQLCMD_ARGS=(-S "$MURA_DBHOST,$MURA_DBPORT" -U "$MURA_DBUSERNAME" -d "$MURA_DATABASE" -b -I -l "$SQLCMD_LOGIN_TIMEOUT")
  # The tools18 build encrypts by default, so it must trust the local server's self-signed certificate.
  if [[ "$(readlink -f "$SQLCMD_BIN" || true)" == */mssql-tools18/* ]]; then
    SQLCMD_ARGS+=(-C)
  else
    help="$(timeout --kill-after=5 10 "$SQLCMD_BIN" '-?' 2>&1)" || true
    if [[ "$help" =~ -C,?[[:space:]]+(Trust|--trust) ]]; then SQLCMD_ARGS+=(-C); fi
  fi
}

# Runs sqlcmd against the legacy database within SQL_DEADLINE seconds, the password passed only through SQLCMDPASSWORD; sets SQL_ERROR on failure.
# No -t: sqlcmd 18 reports a query timeout with exit 0 and runs the remaining batches, so the deadline is enforced outside it.
sql() {
  local rc=0
  SQLCMDPASSWORD="$MURA_DBPASSWORD" timeout --kill-after=10 "$SQL_DEADLINE" "$SQLCMD_BIN" "${SQLCMD_ARGS[@]}" "$@" >"$SQLCMD_OUT" 2>&1 || rc=$?
  if (( rc == 124 || rc == 137 )); then
    SQL_ERROR="sqlcmd timed out after $SQL_DEADLINE s"
  elif (( rc != 0 )); then
    SQL_ERROR="$(sed -e '/^[[:space:]]*$/d' "$SQLCMD_OUT" | tail -n 1)"
    [[ -n "$SQL_ERROR" ]] || SQL_ERROR="no output from $SQLCMD_BIN"
    SQL_ERROR="sqlcmd exited $rc: ${SQL_ERROR:0:300}"
  fi
  return "$rc"
}

# Runs one query and sets SCALAR to its output, without trailing blanks or empty lines.
scalar() {
  sql -h -1 -W -Q "SET NOCOUNT ON; $1" || return
  SCALAR="$(sed -e 's/[[:space:]]*$//' -e '/^$/d' "$SQLCMD_OUT")"
}

# Appends a reason when the legacy database is unreachable or cannot hold the fixture schema.
check_database() {
  if ! scalar "SELECT CASE WHEN HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE SCHEMA') = 1 OR SCHEMA_ID('synthetic') IS NOT NULL THEN 1 ELSE 0 END"; then
    REASONS+=("legacy database unreachable ($SQL_ERROR)")
  elif [[ "$SCALAR" != "1" ]]; then
    REASONS+=("no CREATE SCHEMA permission in $MURA_DATABASE")
  fi
}

# Runs every sql/ file in LC_ALL=C path order.
load_sql_files() {
  local listing rel
  local -a files
  STEP="list sql"
  listing="$(cd "$SCRIPT_DIR/sql" && find . -type f -name '*.sql' -printf '%P\n' | LC_ALL=C sort)"
  mapfile -t files <<<"$listing"
  for rel in "${files[@]}"; do
    [[ -n "$rel" ]] || continue
    STEP="load sql/$rel"
    sql -i "$SCRIPT_DIR/sql/$rel" || fail "$SQL_ERROR"
    printf 'loaded sql/%s\n' "$rel" >&2
  done
}

CHECK_ONLY=0
if (( $# > 0 )); then
  if [[ $# -eq 1 && ( "$1" == -h || "$1" == --help ) ]]; then
    usage
    exit 0
  fi
  if [[ $# -eq 1 && "$1" == --check-only ]]; then
    CHECK_ONLY=1
  else
    printf 'load-fixtures: unexpected arguments: %s\n' "$*" >&2
    usage >&2
    exit 2
  fi
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
# Rejects a relative state directory or one that resolves, through symlinks too, into the checkout.
STATE_DIR="$(realpath -m -- "$OPT2_STATE_DIR")"
if [[ "$OPT2_STATE_DIR" != /* || "$STATE_DIR/" == "$REPO_ROOT/"* ]]; then
  printf 'load-fixtures: OPT2_STATE_DIR must be an absolute path outside the repository checkout %s, got %s\n' "$REPO_ROOT" "$OPT2_STATE_DIR" >&2
  exit 2
fi
OPT2_STATE_DIR="$STATE_DIR"
STATUS_FILE="$OPT2_STATE_DIR/fixtures.json"
WORK_DIR="$OPT2_STATE_DIR/fixtures"
SQLCMD_OUT="$WORK_DIR/sqlcmd.out"

trap 'fail "exit $? at line $LINENO"' ERR
trap 'fail interrupted' INT TERM

mkdir -p "$WORK_DIR"
# Runs on one state directory share WORK_DIR, so they take turns.
exec 9>"$WORK_DIR/lock"
flock 9
# Replaced by the run's outcome, so a killed run never leaves an earlier "fixtures loaded".
write_status false "in progress"
for name in MURA_DATABASE MURA_DBUSERNAME MURA_DBPASSWORD; do
  [[ -n "${!name}" ]] || fail "$name is not set"
done

STEP="capability checks"
if resolve_sqlcmd; then
  check_database
else
  REASONS+=("sqlcmd not found")
fi

if (( ${#REASONS[@]} > 0 )); then
  join_by "; " "${REASONS[@]}"
  STEP="status"
  write_status false "$JOINED"
  printf 'load-fixtures: fixtures unavailable: %s\n' "$JOINED" >&2
  exit 0
fi

if (( CHECK_ONLY == 1 )); then
  STEP="status"
  write_status true "capability checks passed; nothing loaded (--check-only)"
  printf 'load-fixtures: fixtures available; nothing loaded (--check-only)\n' >&2
  exit 0
fi

SQL_DEADLINE="$LOAD_DEADLINE"
load_sql_files

STEP="status"
write_status true "fixtures loaded"
printf 'load-fixtures: fixtures loaded\n' >&2
