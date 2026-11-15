# shellcheck shell=bash
# Run lock of the reproducibility commands: one OPT-2 stack per host and one OPT-2 command at a time.

if [[ -z ${OPT2_COMMON_SH_LOADED:-} ]] || ! declare -F die >/dev/null; then
  printf 'opt2: %s must be sourced after harness/repro/lib/common.sh\n' "${BASH_SOURCE[0]}" >&2
  return 1
fi

# Under $HOME rather than OPT2_STATE_DIR: a clean clone runs with a fresh state directory but must see the same lock.
OPT2_LOCK_DIR="${HOME:?HOME is not set}/.opt2"
OPT2_LOCK_FILE="$OPT2_LOCK_DIR/run.lock"
OPT2_LOCK_FLOCK="$OPT2_LOCK_DIR/run.lock.flock"

# _opt2_lock_read <strict|lenient> <file> <key…>: prints each key's string or number value of the JSON object in
# <file>, one per line (empty when absent). Unreadable input dies when strict and prints nothing when lenient.
_opt2_lock_read() {
  # shellcheck disable=SC2016 # JavaScript source
  node -e '
const [mode, file, ...keys] = process.argv.slice(1);
let doc;
try { doc = JSON.parse(require("fs").readFileSync(file, "utf8")); } catch (err) { doc = err; }
if (doc === null || typeof doc !== "object" || Array.isArray(doc) || doc instanceof Error) {
  if (mode === "lenient") process.exit(0);
  const detail = doc instanceof Error ? `: ${doc.message.replace(/\s+/g, " ")}` : "";
  process.stderr.write(`opt2: ${file} is not a JSON object${detail}; remove it when no OPT-2 command or stack is running\n`);
  process.exit(1);
}
for (const key of keys) {
  const value = Object.hasOwn(doc, key) ? doc[key] : undefined;
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
  process.stdout.write(`${text.replace(/[\r\n]+/g, " ")}\n`);
}
' -- "$@"
}

# _opt2_lock_load <array> <strict|lenient> <file> <key…>: fills the named array with the keys' values; leaves it
# empty when <file> is absent or empty.
_opt2_lock_load() {
  local -n _opt2_lock_into=$1
  local text
  _opt2_lock_into=()
  [[ -s $3 ]] || return 0
  text="$(_opt2_lock_read "${@:2}")" || exit 1
  [[ -n $text || $2 == strict ]] || return 0
  mapfile -t _opt2_lock_into <<<"$text"
}

# _opt2_lock_json <timestamp-key> <key> <value> …: prints a one-line JSON object of the pairs, `pid` as a number,
# plus <timestamp-key> set to the current UTC time.
_opt2_lock_json() {
  # shellcheck disable=SC2016 # JavaScript source
  node -e '
const [stampKey, ...pairs] = process.argv.slice(1);
const doc = {};
for (let i = 0; i + 1 < pairs.length; i += 2) doc[pairs[i]] = pairs[i] === "pid" ? Number(pairs[i + 1]) : pairs[i + 1];
doc[stampKey] = new Date().toISOString();
process.stdout.write(`${JSON.stringify(doc)}\n`);
' -- "$@"
}

# True when $1 is a positive integer naming a live, non-zombie process.
_opt2_lock_pid_alive() {
  local stat
  [[ ${1:-} =~ ^[1-9][0-9]*$ ]] || return 1
  kill -0 "$1" 2>/dev/null || return 1
  [[ -r /proc/$1/stat ]] || return 0
  stat="$(<"/proc/$1/stat")" || return 1
  stat=${stat##*) }
  [[ ${stat%% *} != Z ]]
}

# _opt2_lock_describe <checkout> <command> <pid> <since>: prints `<checkout> (command …, pid …, since …)`.
_opt2_lock_describe() {
  printf '%s (command %s, pid %s, since %s)' "${1:-?}" "${2:-?}" "${3:-?}" "${4:-?}"
}

# Prints every processes.<name>.pid of the up.json file $1; nothing when it is missing or unreadable.
_opt2_lock_up_pids() {
  # shellcheck disable=SC2016 # JavaScript source
  node -e '
let doc;
try { doc = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch { process.exit(0); }
const processes = doc !== null && typeof doc === "object" ? doc.processes : undefined;
if (processes === null || typeof processes !== "object" || Array.isArray(processes)) process.exit(0);
for (const entry of Object.values(processes)) {
  if (entry !== null && typeof entry === "object" && Number.isInteger(entry.pid) && entry.pid > 0) {
    process.stdout.write(`${entry.pid}\n`);
  }
}
' -- "$1"
}

# Prints the run lock record as JSON, or nothing when no stack holds the lock.
lock_holder() {
  [[ -f $OPT2_LOCK_FILE ]] || return 0
  cat -- "$OPT2_LOCK_FILE"
}

# True when the run lock exists and its pid, or any process recorded in its stack's up.json, is alive.
lock_holder_live() {
  local pid
  local -a lock=()
  _opt2_lock_load lock strict "$OPT2_LOCK_FILE" pid stateDir
  ((${#lock[@]} > 0)) || return 1
  if _opt2_lock_pid_alive "${lock[0]:-}"; then return 0; fi
  [[ -n ${lock[1]:-} ]] || return 1
  while IFS= read -r pid; do
    if _opt2_lock_pid_alive "$pid"; then return 0; fi
  done < <(_opt2_lock_up_pids "${lock[1]}/up.json")
  return 1
}

# Takes the per-command flock for the life of this shell; dies naming the running command when another holds it.
_opt2_lock_flock() {
  local command=$1 shell_pid=$BASHPID record stack=""
  local -a holder=() lock=()
  # Built before locking so the previous holder's record is replaced the moment the lock is taken.
  record="$(_opt2_lock_json startedAt checkout "$REPO" command "$command" pid "$$")" ||
    die "cannot build the flock holder record"
  exec 9>>"$OPT2_LOCK_FLOCK" || die "cannot open $OPT2_LOCK_FLOCK"
  if ! flock -n 9; then
    _opt2_lock_load holder lenient "$OPT2_LOCK_FLOCK" checkout command pid startedAt
    # A finished command's lock lasts only until the kernel has killed its holder process, so wait briefly for that.
    if _opt2_lock_pid_alive "${holder[2]:-}" || ! flock -w 2 9; then
      _opt2_lock_load lock lenient "$OPT2_LOCK_FILE" checkout command pid acquiredAt
      if ((${#lock[@]} > 0)); then stack="; stack: $(_opt2_lock_describe "${lock[@]}")"; fi
      die "another OPT-2 command is running: $(_opt2_lock_describe "${holder[@]}")$stack"
    fi
  fi
  printf '%s\n' "$record" >"$OPT2_LOCK_FLOCK"
  # Processes this shell starts (services, emulators) would inherit fd 9 and keep the lock after it exits, so a
  # helper the kernel kills when this shell exits holds the lock instead and fd 9 is closed here. The PPID check
  # covers a shell that exited before setpriv armed the signal: the helper was reparented by then.
  # shellcheck disable=SC2016 # $1 expands in the helper shell
  setpriv --pdeathsig KILL bash -c '[[ $PPID == "$1" ]] && exec sleep infinity' _ "$shell_pid" \
    </dev/null >/dev/null 2>&1 &
  disown "$!"
  exec 9>&-
}

# lock_acquire <up|test-all|down|clean-checkout-proof>: takes the per-command flock, refuses while another checkout's
# stack is live, clears a stale one, and for `up` records this checkout's stack in the run lock.
lock_acquire() {
  local command=${1:?lock_acquire needs a command} record tmp
  local -a lock=()
  case $command in
    up | test-all | down | clean-checkout-proof) ;;
    *) die "lock_acquire: unknown command '$command' (expected up, test-all, down or clean-checkout-proof)" ;;
  esac
  require_cmd flock setpriv node
  mkdir -m 0700 -- "$OPT2_LOCK_DIR" 2>/dev/null || [[ -d $OPT2_LOCK_DIR ]] || die "cannot create $OPT2_LOCK_DIR"
  if [[ -z ${OPT2_LOCK_FLOCK_HELD:-} ]]; then
    _opt2_lock_flock "$command"
    export OPT2_LOCK_FLOCK_HELD=1
  fi

  _opt2_lock_load lock strict "$OPT2_LOCK_FILE" checkout command pid acquiredAt
  if ((${#lock[@]} > 0)) && [[ ${lock[0]:-} != "$REPO" ]]; then
    [[ -n ${lock[0]:-} ]] || die "$OPT2_LOCK_FILE names no checkout; remove it when no OPT-2 stack is running"
    if lock_holder_live; then
      die "the live OPT-2 stack of $(_opt2_lock_describe "${lock[@]}") holds $OPT2_LOCK_FILE;" \
        "run ${lock[0]}/harness/repro/down.sh first"
    fi
    printf 'opt2: clearing stale run lock of %s\n' "${lock[0]}" >&2
    rm -f -- "$OPT2_LOCK_FILE"
  fi

  [[ $command == up ]] || return 0
  record="$(_opt2_lock_json acquiredAt checkout "$REPO" stateDir "$OPT2_STATE_DIR" pid "$$" command "$command")" ||
    die "cannot build the run lock record"
  tmp="$(mktemp -- "$OPT2_LOCK_FILE.XXXXXX")" || die "cannot create a temporary file in $OPT2_LOCK_DIR"
  if ! printf '%s\n' "$record" >"$tmp" || ! chmod 600 -- "$tmp" || ! mv -f -- "$tmp" "$OPT2_LOCK_FILE"; then
    rm -f -- "$tmp"
    die "cannot write $OPT2_LOCK_FILE"
  fi
}

# Dies unless the run lock records this checkout's stack.
lock_assert_mine() {
  local -a lock=()
  _opt2_lock_load lock strict "$OPT2_LOCK_FILE" checkout
  [[ ${lock[0]:-} == "$REPO" ]] || die "no OPT-2 stack is running for this checkout; run harness/repro/up.sh"
}

# Removes the run lock when it is absent or held by this checkout; another checkout's lock is left in place.
lock_release() {
  local -a lock=()
  _opt2_lock_load lock strict "$OPT2_LOCK_FILE" checkout
  if ((${#lock[@]} == 0)) || [[ ${lock[0]:-} == "$REPO" ]]; then
    rm -f -- "$OPT2_LOCK_FILE"
    return 0
  fi
  printf 'opt2: run lock of %s left in place\n' "${lock[0]}" >&2
}
