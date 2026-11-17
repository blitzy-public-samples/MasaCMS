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
OPT2_LOCK_QUEUE="$OPT2_LOCK_DIR/run.queue"

# _opt2_lock_read <strict|lenient> <file> <key…>: prints each key's string or number value of the JSON object in
# <file>, one per line (empty when absent); a dotted key reads a nested object, and an array prints `, `-joined.
# Exits 3 when <file> no longer exists. Unreadable input dies when strict and prints nothing when lenient.
_opt2_lock_read() {
  # shellcheck disable=SC2016 # JavaScript source
  node -e '
const [mode, file, ...keys] = process.argv.slice(1);
let doc;
try { doc = JSON.parse(require("fs").readFileSync(file, "utf8")); } catch (err) { doc = err; }
if (doc instanceof Error && doc.code === "ENOENT") process.exit(3);
if (doc === null || typeof doc !== "object" || Array.isArray(doc) || doc instanceof Error) {
  if (mode === "lenient") process.exit(0);
  const detail = doc instanceof Error ? `: ${doc.message.replace(/\s+/g, " ")}` : "";
  process.stderr.write(`opt2: ${file} is not a JSON object${detail}; remove it when no OPT-2 command or stack is running\n`);
  process.exit(1);
}
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
for (const key of keys) {
  let value = doc;
  for (const part of key.split(".")) value = isObject(value) && Object.hasOwn(value, part) ? value[part] : undefined;
  if (Array.isArray(value)) value = value.filter((item) => ["string", "number"].includes(typeof item)).join(", ");
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
  process.stdout.write(`${text.replace(/[\r\n]+/g, " ")}\n`);
}
' -- "$@"
}

# _opt2_lock_load <array> <strict|lenient> <file> <key…>: fills the named array with the keys' values; leaves it
# empty when <file> is absent or empty, or removed while being read.
_opt2_lock_load() {
  local -n _opt2_lock_into=$1
  local text status=0
  _opt2_lock_into=()
  [[ -s $3 ]] || return 0
  text="$(_opt2_lock_read "${@:2}")" || status=$?
  ((status != 3)) || return 0
  ((status == 0)) || exit 1
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

# Fills OPT2_LOCK_STAT with the /proc/<pid>/stat fields after the command name (state first, so field n is at index
# n - 3); returns 1 unless pid $1 runs and is no zombie.
_opt2_lock_stat() {
  local stat=""
  OPT2_LOCK_STAT=()
  [[ ${1:-} =~ ^[1-9][0-9]*$ ]] || return 1
  { IFS= read -r -d '' stat <"/proc/$1/stat"; } 2>/dev/null || :
  [[ $stat == *') '* ]] || return 1
  read -r -a OPT2_LOCK_STAT <<<"${stat##*) }"
  [[ ${OPT2_LOCK_STAT[0]:-} != Z ]]
}

# _opt2_lock_is_ancestor <ancestor> <pid>: true when <ancestor> is <pid> or one of its ancestors.
_opt2_lock_is_ancestor() {
  local pid=$2
  while [[ $pid =~ ^[1-9][0-9]*$ ]]; do
    [[ $pid != "$1" ]] || return 0
    _opt2_lock_stat "$pid" || return 1
    pid=${OPT2_LOCK_STAT[1]:-}
  done
  return 1
}

# _opt2_lock_describe <checkout> <command> <pid> <since>: prints `<checkout> (command …, pid …, since …)`.
_opt2_lock_describe() {
  printf '%s (command %s, pid %s, since %s)' "${1:-?}" "${2:-?}" "${3:-?}" "${4:-?}"
}

# Prints `<pid>\t<start time>` for every processes.<name> of the up.json file $1, the start time empty when none is
# recorded; nothing when the file is missing or unreadable.
_opt2_lock_up_pids() {
  # shellcheck disable=SC2016 # JavaScript source
  node -e '
let doc;
try { doc = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch { process.exit(0); }
const processes = doc !== null && typeof doc === "object" ? doc.processes : undefined;
if (processes === null || typeof processes !== "object" || Array.isArray(processes)) process.exit(0);
const start = (entry) => (typeof entry.startTime === "string" && /^\d+$/.test(entry.startTime) ? entry.startTime : "");
const pids = Object.values(processes)
  .filter((entry) => entry !== null && typeof entry === "object" && Number.isInteger(entry.pid) && entry.pid > 0)
  .map((entry) => `${entry.pid}\t${start(entry)}\n`);
// One write: the reader stops at the first live pid, and a later write to its closed pipe would raise EPIPE.
process.stdout.write(pids.join(""));
' -- "$1"
}

# Prints the run lock record as JSON, or nothing when no stack holds the lock.
lock_holder() {
  [[ -f $OPT2_LOCK_FILE ]] || return 0
  cat -- "$OPT2_LOCK_FILE"
}

# True when the run lock exists and its pid, or any process recorded in its stack's up.json, is alive with the start
# time recorded for it, when one is.
lock_holder_live() {
  local pid start
  local -a lock=()
  _opt2_lock_load lock strict "$OPT2_LOCK_FILE" pid stateDir startTime
  ((${#lock[@]} > 0)) || return 1
  if _opt2_lock_pid_alive "${lock[0]:-}" && _opt2_proc_start_matches "${lock[0]}" "${lock[2]:-}"; then return 0; fi
  [[ -n ${lock[1]:-} ]] || return 1
  while IFS=$'\t' read -r pid start; do
    if _opt2_lock_pid_alive "$pid" && _opt2_proc_start_matches "$pid" "$start"; then return 0; fi
  done < <(_opt2_lock_up_pids "${lock[1]}/up.json")
  return 1
}

# Prints the checkout the run lock names; nothing when there is no run lock or it cannot be read.
lock_checkout() {
  local -a lock=()
  _opt2_lock_load lock lenient "$OPT2_LOCK_FILE" checkout
  printf '%s\n' "${lock[0]:-}"
}

# _opt2_lock_write <file> <json>: replaces <file> atomically with the one-line JSON, mode 600.
_opt2_lock_write() {
  local tmp
  tmp="$(mktemp -- "$1.XXXXXX")" || die "cannot create a temporary file in ${1%/*}"
  if ! printf '%s\n' "$2" >"$tmp" || ! chmod 600 -- "$tmp" || ! mv -f -- "$tmp" "$1"; then
    rm -f -- "$tmp"
    die "cannot write $1"
  fi
}

# Sets OPT2_LOCK_STATE from the run lock (none; mine or mine-recovery; another checkout's live, recovery or stale, named
# in OPT2_LOCK_HOLDER) and OPT2_LOCK_REASON for the held states; a record with a teardown is held whatever its pids.
_opt2_lock_classify() {
  local -a lock=()
  OPT2_LOCK_STATE=none
  OPT2_LOCK_REASON=""
  OPT2_LOCK_HOLDER=""
  _opt2_lock_load lock strict "$OPT2_LOCK_FILE" checkout command pid acquiredAt teardown.state teardown.pid \
    teardown.startedAt teardown.failedSteps
  ((${#lock[@]} > 0)) || return 0
  [[ -n ${lock[0]:-} ]] || die "$OPT2_LOCK_FILE names no checkout; remove it when no OPT-2 stack is running"
  OPT2_LOCK_HOLDER=${lock[0]}
  if [[ -n ${lock[4]:-} ]]; then
    if [[ ${lock[4]} == running ]] && _opt2_lock_pid_alive "${lock[5]:-}"; then
      OPT2_LOCK_REASON="the OPT-2 stack of ${lock[0]} is being torn down by its down.sh (pid ${lock[5]}, since"
      OPT2_LOCK_REASON+=" ${lock[6]:-?})"
    else
      OPT2_LOCK_REASON="the OPT-2 stack of ${lock[0]} needs recovery: its down.sh (pid ${lock[5]:-?}, since"
      OPT2_LOCK_REASON+=" ${lock[6]:-?}) did not finish${lock[7]:+; failed steps: ${lock[7]}}"
      OPT2_LOCK_REASON+=": run ${lock[0]}/harness/repro/down.sh"
    fi
    OPT2_LOCK_STATE=recovery
    [[ ${lock[0]} != "$REPO" ]] || OPT2_LOCK_STATE=mine-recovery
  elif [[ ${lock[0]} == "$REPO" ]]; then
    OPT2_LOCK_STATE=mine
  elif lock_holder_live; then
    OPT2_LOCK_STATE=live
    OPT2_LOCK_REASON="the live OPT-2 stack of $(_opt2_lock_describe "${lock[@]:0:4}") holds $OPT2_LOCK_FILE;"
    OPT2_LOCK_REASON+=" run ${lock[0]}/harness/repro/down.sh first"
  else
    OPT2_LOCK_STATE=stale
  fi
}

# _opt2_lock_flock_owners <pid>: prints `pid <n> (<executable>, cwd <directory>)`, `, `-joined, for each process
# outside <pid>'s own tree that holds the per-command flock; never its arguments, which may carry secrets.
_opt2_lock_flock_owners() {
  local link pid fd comm cwd out="" seen=" "
  while IFS= read -r link; do
    pid=${link#/proc/}
    pid=${pid%%/*}
    fd=${link##*/}
    [[ $seen != *" $pid "* ]] || continue
    # fdinfo lists the locks of an open file only for its holders, never for a process blocked waiting on it.
    grep -qs '^lock:.*FLOCK' -- "/proc/$pid/fdinfo/$fd" || continue
    if _opt2_lock_is_ancestor "$1" "$pid"; then continue; fi
    seen+="$pid "
    { IFS= read -r comm <"/proc/$pid/comm"; } 2>/dev/null || comm=""
    cwd="$(readlink -- "/proc/$pid/cwd" 2>/dev/null)" || cwd=""
    out+="${out:+, }pid $pid (${comm:-?}, cwd ${cwd:-?})"
  done < <(find /proc/[0-9]*/fd -maxdepth 1 -lname "$OPT2_LOCK_FLOCK" 2>/dev/null)
  printf '%s' "$out"
}

# Sets OPT2_LOCK_REASON to who holds the per-command flock: the OPT-2 command its record names, or the processes
# holding it when that command has exited (an external `flock` wrapper, say).
_opt2_lock_flock_busy() {
  local self=$BASHPID stack="" owners
  local -a holder=() lock=()
  _opt2_lock_load holder lenient "$OPT2_LOCK_FLOCK" checkout command pid startedAt
  _opt2_lock_load lock lenient "$OPT2_LOCK_FILE" checkout command pid acquiredAt
  if ((${#lock[@]} > 0)); then stack="; stack: $(_opt2_lock_describe "${lock[@]}")"; fi
  OPT2_LOCK_REASON="another OPT-2 command is running: $(_opt2_lock_describe "${holder[@]}")$stack"
  if _opt2_lock_pid_alive "${holder[2]:-}"; then return 0; fi
  owners="$(_opt2_lock_flock_owners "$self")"
  if [[ -n $owners ]]; then
    OPT2_LOCK_REASON="$OPT2_LOCK_FLOCK is held by $owners, not by an OPT-2 command (the last one recorded,"
    OPT2_LOCK_REASON+=" $(_opt2_lock_describe "${holder[@]}"), has exited)$stack"
  fi
}

# _opt2_lock_flock_try <command>: takes the per-command flock for the life of this shell and exports its token as
# OPT2_LOCK_FLOCK_HELD; returns 1 when another process holds it.
_opt2_lock_flock_try() {
  local command=$1 shell_pid=$BASHPID token record
  local -a holder=()
  token="$(</proc/sys/kernel/random/uuid)" || die "cannot read a token from /proc/sys/kernel/random/uuid"
  # Built before locking so the previous holder's record is replaced the moment the lock is taken.
  record="$(_opt2_lock_json startedAt checkout "$REPO" command "$command" pid "$shell_pid" token "$token")" ||
    die "cannot build the flock holder record"
  exec 9>>"$OPT2_LOCK_FLOCK" || die "cannot open $OPT2_LOCK_FLOCK"
  if ! flock -n 9; then
    _opt2_lock_load holder lenient "$OPT2_LOCK_FLOCK" pid
    # A finished command's lock lasts only until the kernel has killed its holder process, so wait briefly for that.
    if _opt2_lock_pid_alive "${holder[0]:-}" || ! flock -w 2 9; then
      exec 9>&-
      return 1
    fi
  fi
  printf '%s\n' "$record" >"$OPT2_LOCK_FLOCK" || die "cannot write $OPT2_LOCK_FLOCK"
  # Processes this shell starts (services, emulators) would inherit fd 9 and keep the lock after it exits, so a
  # helper the kernel kills when this shell exits holds the lock instead and fd 9 is closed here. The PPID check
  # covers a shell that exited before setpriv armed the signal: the helper was reparented by then. The helper ignores
  # HUP, INT and TERM sent to this shell's process group, so the lock lasts until this shell has handled them.
  # shellcheck disable=SC2016 # $1 expands in the helper shell
  setpriv --pdeathsig KILL bash -c 'trap "" HUP INT TERM; [[ $PPID == "$1" ]] && exec sleep infinity' _ "$shell_pid" \
    </dev/null >/dev/null 2>&1 &
  OPT2_LOCK_HELPER=$!
  disown "$!"
  exec 9>&-
  export OPT2_LOCK_FLOCK_HELD=$token
}

# Releases the per-command flock _opt2_lock_flock_try took in this shell.
_opt2_lock_unflock() {
  kill -KILL "$OPT2_LOCK_HELPER" 2>/dev/null || :
  unset OPT2_LOCK_FLOCK_HELD
}

# True when OPT2_LOCK_FLOCK_HELD is the token of the per-command flock held by this shell or a live ancestor, which
# the command then runs under; any other value is dropped with a note.
_opt2_lock_flock_inherited() {
  local -a holder=()
  [[ -n ${OPT2_LOCK_FLOCK_HELD:-} ]] || return 1
  _opt2_lock_load holder lenient "$OPT2_LOCK_FLOCK" token pid
  if [[ ${holder[0]:-} == "$OPT2_LOCK_FLOCK_HELD" ]] && _opt2_lock_pid_alive "${holder[1]:-}" &&
    _opt2_lock_is_ancestor "${holder[1]}" "$BASHPID"; then
    return 0
  fi
  printf 'opt2: ignoring OPT2_LOCK_FLOCK_HELD: no parent OPT-2 command holds the per-command flock\n' >&2
  unset OPT2_LOCK_FLOCK_HELD
  return 1
}

# _opt2_lock_deadline <start> <wait-s>: dies with OPT2_LOCK_REASON once <wait-s> seconds have passed since <start>.
_opt2_lock_deadline() {
  local waited=$((SECONDS - $1))
  if ((waited < $2)); then return 0; fi
  if (($2 == 0)); then die "$OPT2_LOCK_REASON"; fi
  die "$OPT2_LOCK_REASON (waited ${waited}s, OPT2_LOCK_WAIT=$2)"
}

# _opt2_lock_poll <command> <wait-s>: takes the per-command flock, retrying each second for up to <wait-s> seconds.
_opt2_lock_poll() {
  local start=$SECONDS
  until _opt2_lock_flock_try "$1"; do
    _opt2_lock_flock_busy
    _opt2_lock_deadline "$start" "$2"
    sleep 1
  done
}

# Fills OPT2_LOCK_TICKETS with the queue's ticket names, oldest first, removing the tickets of exited processes.
_opt2_lock_queue_scan() {
  local LC_ALL=C path name pid began
  OPT2_LOCK_TICKETS=()
  for path in "$OPT2_LOCK_QUEUE"/*; do
    name=${path##*/}
    [[ $name =~ ^[0-9]{20}-([1-9][0-9]*)-([0-9]+)$ ]] || continue
    pid=${BASH_REMATCH[1]}
    began=${BASH_REMATCH[2]}
    if _opt2_lock_stat "$pid" && [[ ${OPT2_LOCK_STAT[19]:-} == "$began" ]]; then
      OPT2_LOCK_TICKETS+=("$name")
    else
      rm -f -- "$path"
    fi
  done
}

# _opt2_lock_queue_ahead [ticket]: sets OPT2_LOCK_REASON when OPT2_LOCK_TICKETS holds tickets ahead of <ticket> (any,
# without one); returns 1 when it holds none.
_opt2_lock_queue_ahead() {
  local name first="" count=0
  local -a ticket=()
  for name in "${OPT2_LOCK_TICKETS[@]}"; do
    [[ $name != "${1:-}" ]] || break
    count=$((count + 1))
    first=${first:-$name}
  done
  ((count > 0)) || return 1
  _opt2_lock_load ticket lenient "$OPT2_LOCK_QUEUE/$first" checkout command pid queuedAt
  OPT2_LOCK_REASON="$count claimant(s) queued for the OPT-2 stack ahead of this one, first"
  OPT2_LOCK_REASON+=" $(_opt2_lock_describe "${ticket[@]}")"
}

# _opt2_lock_queue <command> <wait-s>: queues a ticket <epoch-ns>-<pid>-<starttime> and, once it heads the queue and
# no other checkout's stack holds the run lock, takes the per-command flock; dies after <wait-s> seconds.
_opt2_lock_queue() {
  local command=$1 wait=$2 start=$SECONDS self=$BASHPID began name ticket record
  _opt2_lock_stat "$self" || die "cannot read /proc/$self/stat"
  began=${OPT2_LOCK_STAT[19]:-}
  [[ $began =~ ^[0-9]+$ ]] || die "cannot read the start time of pid $self from /proc/$self/stat"
  name="$(printf '%020d' "$(date +%s%N)")-$self-$began"
  ticket="$OPT2_LOCK_QUEUE/$name"
  record="$(_opt2_lock_json queuedAt checkout "$REPO" command "$command" pid "$self" starttime "$began")" ||
    die "cannot build the queue ticket"
  printf 'opt2: queued for the OPT-2 stack as %s; waiting up to %ss\n' "$ticket" "$wait" >&2
  while true; do
    if [[ ! -e $ticket ]]; then
      mkdir -m 0700 -- "$OPT2_LOCK_QUEUE" 2>/dev/null || [[ -d $OPT2_LOCK_QUEUE ]] ||
        die "cannot create $OPT2_LOCK_QUEUE"
      _opt2_lock_write "$ticket" "$record"
    fi
    _opt2_lock_queue_scan
    if [[ ${OPT2_LOCK_TICKETS[0]:-} != "$name" ]]; then
      _opt2_lock_queue_ahead "$name" || :
    else
      # Read without the flock first, so a waiting head never blocks the stack owner's test-all.sh or down.sh.
      _opt2_lock_classify
      if [[ $OPT2_LOCK_STATE != live && $OPT2_LOCK_STATE != recovery ]]; then
        if ! _opt2_lock_flock_try "$command"; then
          _opt2_lock_flock_busy
        else
          _opt2_lock_classify
          if [[ $OPT2_LOCK_STATE != live && $OPT2_LOCK_STATE != recovery ]]; then
            rm -f -- "$ticket"
            return 0
          fi
          _opt2_lock_unflock
        fi
      fi
    fi
    if ((SECONDS - start >= wait)); then
      rm -f -- "$ticket"
      _opt2_lock_deadline "$start" "$wait"
    fi
    sleep 1
  done
}

# lock_acquire <up|test-all|down|clean-checkout-proof>: takes the per-command flock (or a parent OPT-2 command's) and
# refuses while another checkout's stack is live or awaiting recovery; OPT2_LOCK_WAIT=<seconds> waits instead. Only up
# and clean-checkout-proof queue and clear another checkout's stale lock.
lock_acquire() {
  local command=${1:?lock_acquire needs a command} wait=${OPT2_LOCK_WAIT:-0} claim=false
  case $command in
    up | clean-checkout-proof) claim=true ;;
    test-all | down) ;;
    *) die "lock_acquire: unknown command '$command' (expected up, test-all, down or clean-checkout-proof)" ;;
  esac
  [[ $wait =~ ^[0-9]{1,9}$ ]] || die "OPT2_LOCK_WAIT must be a whole number of seconds (at most 9 digits), got '$wait'"
  wait=$((10#$wait))
  require_cmd flock setpriv node
  mkdir -m 0700 -- "$OPT2_LOCK_DIR" 2>/dev/null || [[ -d $OPT2_LOCK_DIR ]] || die "cannot create $OPT2_LOCK_DIR"
  if ! _opt2_lock_flock_inherited; then
    _opt2_lock_classify
    if [[ $OPT2_LOCK_STATE == mine-recovery && $command != down ]]; then die "$OPT2_LOCK_REASON"; fi
    # Claimants of a new stack queue; the checkout whose live stack holds the run lock never waits behind them.
    if [[ $claim == true ]] && ! { [[ $OPT2_LOCK_STATE == mine ]] && lock_holder_live; }; then
      if ((wait > 0)); then
        _opt2_lock_queue "$command" "$wait"
      else
        _opt2_lock_queue_scan
        if _opt2_lock_queue_ahead; then die "$OPT2_LOCK_REASON; set OPT2_LOCK_WAIT=<seconds> to queue behind them"; fi
        _opt2_lock_poll "$command" 0
      fi
    else
      _opt2_lock_poll "$command" "$wait"
    fi
  fi

  _opt2_lock_classify
  case $OPT2_LOCK_STATE in
    live | recovery) die "$OPT2_LOCK_REASON" ;;
    mine-recovery) [[ $command == down ]] || die "$OPT2_LOCK_REASON" ;;
    stale)
      if [[ $claim == true ]]; then
        printf 'opt2: clearing stale run lock of %s\n' "$OPT2_LOCK_HOLDER" >&2
        rm -f -- "$OPT2_LOCK_FILE"
      fi
      ;;
  esac
}

# Records this checkout's stack in the run lock; up.sh calls it once its preconditions hold.
lock_claim_stack() {
  local record start
  local -a identity=()
  # The start time lets lock_holder_live tell this shell from a later process the kernel gives the same pid.
  start="$(_opt2_proc_start_time "$$")" || start=""
  if [[ -n $start ]]; then identity=(startTime "$start"); fi
  record="$(_opt2_lock_json acquiredAt checkout "$REPO" stateDir "$OPT2_STATE_DIR" pid "$$" "${identity[@]}" \
    command up)" || die "cannot build the run lock record"
  _opt2_lock_write "$OPT2_LOCK_FILE" "$record"
}

# _opt2_lock_teardown_record <running|failed> [step…]: prints this checkout's run lock record, or a fresh one in place
# of another checkout's or none, with teardown {pid, startedAt, state} and, when failed, failedSteps and finishedAt.
_opt2_lock_teardown_record() {
  # shellcheck disable=SC2016 # JavaScript source
  node -e '
const [file, checkout, stateDir, pid, state, ...steps] = process.argv.slice(1);
let doc;
try { doc = JSON.parse(require("fs").readFileSync(file, "utf8")); } catch { doc = undefined; }
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const now = new Date().toISOString();
const record = isObject(doc) && doc.checkout === checkout
  ? doc
  : { checkout, stateDir, pid: Number(pid), command: "down", acquiredAt: now };
const begun = isObject(record.teardown) ? record.teardown : {};
record.teardown = state === "running"
  ? { pid: Number(pid), startedAt: now, state }
  : { pid: begun.pid ?? Number(pid), startedAt: begun.startedAt ?? now, state, failedSteps: steps, finishedAt: now };
process.stdout.write(`${JSON.stringify(record)}\n`);
' -- "$OPT2_LOCK_FILE" "$REPO" "$OPT2_STATE_DIR" "$$" "$@"
}

# Marks this checkout's teardown as begun in the run lock, taking over another checkout's stale record; every other
# checkout treats the stack as held until lock_release, whatever becomes of its processes.
lock_teardown_begin() {
  local record
  record="$(_opt2_lock_teardown_record running)" || die "cannot build the run lock record"
  _opt2_lock_write "$OPT2_LOCK_FILE" "$record"
}

# lock_teardown_failed <step…>: records this checkout's teardown as failed in the named steps; the run lock stays held.
lock_teardown_failed() {
  local record
  record="$(_opt2_lock_teardown_record failed "$@")" || die "cannot build the run lock record"
  _opt2_lock_write "$OPT2_LOCK_FILE" "$record"
}

# Dies unless the run lock leaves the stack free: absent, or a stale record of another checkout.
lock_assert_stack_free() {
  _opt2_lock_classify
  case $OPT2_LOCK_STATE in
    none | stale) ;;
    mine | mine-recovery) die "$OPT2_LOCK_FILE still records this checkout's stack: $(lock_holder)" ;;
    *) die "$OPT2_LOCK_REASON" ;;
  esac
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
