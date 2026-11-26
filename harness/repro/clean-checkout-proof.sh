#!/usr/bin/env bash
# Proves up.sh and test-all.sh from a fresh clone of HEAD; records the result in opt2/reports/reproducibility.md.
set -euo pipefail

# Prints the one-line usage to stderr and exits 2.
usage_error() {
  printf 'usage: harness/repro/clean-checkout-proof.sh [-h|--help]\n' >&2
  exit 2
}

case $# in
  0) ;;
  1)
    case $1 in
      -h | --help)
        cat <<'EOF'
usage: harness/repro/clean-checkout-proof.sh

Stops this checkout's OPT-2 stack (harness/repro/down.sh), clones the current commit with `git clone --no-local`
into ${OPT2_CLONE_PARENT:-$HOME/.opt2}/opt2-clean-<timestamp>, and runs harness/repro/up.sh and then
harness/repro/test-all.sh there with a fresh OPT2_STATE_DIR (<clone>.state) and this checkout's OPT2_PRISTINE_DIR. The
result is recorded in opt2/reports/reproducibility.md of this checkout, then the clone's down.sh stops its stack. The
clone and its state directory are left for inspection; this checkout restarts only by an explicit harness/repro/up.sh.
It holds the per-command lock from the first teardown to the clone's down.sh. Takes no arguments.
OPT2_LOCK_WAIT=<seconds> queues, first come, first served, behind other claimants of the stack for up to that long
instead of refusing at once.

Environment, passed on to the clone's commands:
  required              PORT, MURA_DBHOST, MURA_DBPORT, MURA_DATABASE, MURA_DBUSERNAME, MURA_DBPASSWORD,
                        MURA_ADMIN_PASSWORD, PG_HOST, PG_PORT, PG_USER, PG_PASSWORD, PG_DATABASE and
                        CFCONFIG_ADMINPASSWORD (up.sh); MASA_TEST_EDITOR_PASSWORD (test-all.sh)
  MURA_ADMIN_USERNAME   admin login (default admin)
  OPT2_CLONE_PARENT     where the clone is made (default $HOME/.opt2): absolute, outside this checkout, with no
                        directory named mura, and an existing directory or a path creatable below one
  OPT2_STATE_DIR        this checkout's state, which step 1's down.sh stops (default $HOME/.opt2/state); the clone
                        gets <clone>.state instead
  OPT2_PRISTINE_DIR     pristine legacy baseline, shared with the clone (default $HOME/.opt2/pristine)
  OPT2_PORTS_FILE OPT2_CF_SERVER_NAME OPT2_LOCK_DIR
                        the port file, opt2-legacy's server name and the run lock directory, as for up.sh; this
                        script and every command of the proof use the same ones
  OPT2_REPORTS_DIR      ignored: the clone writes its reports into itself

Example, with the environment up.sh runs under:
  OPT2_CLONE_PARENT=$HOME/opt2-proofs harness/repro/clean-checkout-proof.sh; echo "exit $?"

Exit: 0 proof passed and the clone's stack stopped, 1 proof failed or a step could not run, 2 usage error.
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

# The clone's commands run only under the flock this script takes in step 1, and write their reports into the clone.
unset OPT2_LOCK_FLOCK_HELD OPT2_REPORTS_DIR

REPORT="$REPO/opt2/reports/reproducibility.md"
OPT2_CLONE_PARENT="${OPT2_CLONE_PARENT:-$HOME/.opt2}"

mapfile -t FIELD_LABELS <<'EOF'
Clone path (`opt2-clean-<timestamp>`, outside the working tree; never a directory named `mura`)
Commit (`git rev-parse HEAD` of the clone)
`OPT2_STATE_DIR` (fresh per clone)
`OPT2_PRISTINE_DIR` (shared, default `$HOME/.opt2/pristine`)
`harness/repro/up.sh` exit code (pass: 0)
`harness/repro/test-all.sh` exit code (pass: 0, or 2 when fixtures are unavailable)
`sha256` of the clone's `opt2/reports/test-all.json`
Untracked environment artefacts copied from the working checkout (`OPT2_ENV_ARTEFACTS`)
Uncommitted changes in the working checkout (not part of the proof)
EOF

mapfile -t STEP_ACTIONS <<'EOF'
`harness/repro/down.sh` in the working checkout; release `$HOME/.opt2/run.lock`
`git clone --no-local` the current commit into `opt2-clean-<timestamp>` outside the working tree
In the clone: `harness/repro/up.sh` (restores the pristine database and file store; points `server.json`, the webroot and `/muraWRM` at the clone), then `harness/repro/test-all.sh`
Record the fields above in this file
`harness/repro/down.sh` in the clone (restores the pristine database and file store; removes the clone's `/muraWRM` mapping); the working checkout restarts only by an explicit `harness/repro/up.sh`
EOF

STARTED=()
FINISHED=()
OUTCOME=()
CLONE=""
CLONE_STATE=""
CLONE_COMMIT=""
COPIED=()
DIRTY=()
UP_RC=not-run
TEST_RC=not-run
DOWN_RC=not-run
DIGEST=""
FIXTURES_AVAILABLE=unknown
FIXTURES_REASON=""
STATUS=fail

# True when the clone's state directory or the run lock still records a stack of the clone.
clone_stack_recorded() {
  [[ -n $CLONE_STATE ]] || return 1
  [[ -e $CLONE_STATE/up.json || -e $CLONE_STATE/tooling.json || "$(lock_checkout)" == "$CLONE" ]]
}

# Names the clone's teardown command when the script stops while the clone's stack may still run.
on_exit() {
  local status=$?
  if ((status != 0)) && clone_stack_recorded; then
    printf "opt2: the clone's stack may still be running; stop it with:\n" >&2
    printf '  (cd %s && OPT2_STATE_DIR=%s harness/repro/down.sh)\n' "$CLONE" "$CLONE_STATE" >&2
  fi
}
trap on_exit EXIT

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# step_begin <n> <title>: stamps the step's start and logs it.
step_begin() {
  STARTED[$1]="$(now)"
  log_step "$1" "$2"
}

# step_end <n> <outcome>: stamps the step's end with its outcome.
step_end() {
  FINISHED[$1]="$(now)"
  OUTCOME[$1]=$2
}

# Prints $1 as one Markdown table cell: `|` escaped, line breaks folded.
cell() {
  local text=${1//|/\\|}
  printf '%s' "${text//$'\n'/ }"
}

# Prints $1 as a Markdown code span inside a table cell.
code() { printf "\`%s\`" "$(cell "$1")"; }

# Prints the arguments as code spans joined by `, `, or `none`.
code_list() {
  local out="" item
  for item in "$@"; do out+="${out:+, }$(code "$item")"; done
  printf '%s' "${out:-none}"
}

# run_in_clone <script>: runs the clone's harness/repro/<script> from the clone root with the clone's state directory.
run_in_clone() {
  (cd -- "$CLONE" && OPT2_STATE_DIR=$CLONE_STATE OPT2_PRISTINE_DIR=$OPT2_PRISTINE_DIR "$CLONE/harness/repro/$1") >&2
}

# Writes opt2/reports/reproducibility.md in the layout of its committed placeholder, steps not yet run as pending.
write_report() {
  local n test_text=$TEST_RC digest_text dirty_text
  local -a values=()
  if [[ $TEST_RC == not-run ]]; then
    test_text="not-run (up.sh failed)"
  elif [[ $TEST_RC == 2 && $FIXTURES_AVAILABLE == false ]]; then
    test_text="2 (fixtures unavailable: ${FIXTURES_REASON:-no reason recorded})"
  fi
  if [[ -n $DIGEST ]]; then
    digest_text="$(code "$DIGEST")"
  else
    digest_text="not produced (the committed placeholder is unchanged)"
  fi
  if ((${#DIRTY[@]} == 0)); then
    dirty_text=no
  else
    dirty_text="yes: ${#DIRTY[@]} path(s) not committed, so not cloned"
  fi
  # Directories as variable-relative labels: the report is committed, and host paths differ per run.
  values=("$(code "\$OPT2_CLONE_PARENT/${CLONE##*/}")" "$(code "$CLONE_COMMIT")"
    "$(code "\$OPT2_CLONE_PARENT/${CLONE_STATE##*/}")" "$(code "\$OPT2_PRISTINE_DIR")"
    "$(cell "$UP_RC")" "$(cell "$test_text")" "$digest_text" "$(code_list "${COPIED[@]}")" "$(cell "$dirty_text")")
  {
    printf '# Reproducibility — clean checkout\n\n'
    printf 'Source SHA: %s\n' "$PIN_SHA"
    printf 'Status: %s\n' "$STATUS"
    printf 'Generated by: harness/repro/clean-checkout-proof.sh\n'
    printf 'Generated at: %s\n\n' "$(now)"
    printf '## Result\n\n| Field | Value |\n|---|---|\n'
    for n in "${!FIELD_LABELS[@]}"; do printf '| %s | %s |\n' "${FIELD_LABELS[n]}" "${values[n]}"; done
    printf '\n## Procedure\n\n| Step | Action | Started (UTC) | Finished (UTC) | Outcome |\n|---|---|---|---|---|\n'
    for n in 1 2 3 4 5; do
      printf '| %s | %s | %s | %s | %s |\n' "$n" "${STEP_ACTIONS[n - 1]}" "${STARTED[n]:-pending}" \
        "${FINISHED[n]:-pending}" "$(cell "${OUTCOME[n]:-pending}")"
    done
  } >"$REPORT"
}

# --- Preconditions ---------------------------------------------------------------------------------------------

require_cmd git sha256sum realpath cp
PIN_SHA="$(json_get "$REPO/opt2/source-pin.json" sha)" ||
  die "cannot read the pinned SHA from $REPO/opt2/source-pin.json"
[[ $PIN_SHA =~ ^[0-9a-f]{40}$ ]] || die "$REPO/opt2/source-pin.json holds no 40-character SHA ('$PIN_SHA')"
# The clone path is fixed and checked before step 1 stops the working stack.
_opt2_assert_outside_repo OPT2_CLONE_PARENT
CLONE="$(realpath -m -- "$OPT2_CLONE_PARENT")/opt2-clean-$(date -u +%Y%m%dT%H%M%SZ)"
[[ "/${CLONE,,}/" != */mura/* ]] ||
  die "OPT2_CLONE_PARENT ($OPT2_CLONE_PARENT) resolves to a path with a directory named mura, which collides with" \
    "ColdFusion's built-in /mura mapping (setup §1)"
CLONE_STATE="$CLONE.state"
[[ ! -e $CLONE && ! -e $CLONE_STATE ]] ||
  die "$CLONE or $CLONE_STATE already exists in OPT2_CLONE_PARENT ($OPT2_CLONE_PARENT)"
# The deepest existing component of the parent must be a writable directory, so the clone can be created below it.
parent="$(realpath -m -- "$OPT2_CLONE_PARENT")"
while [[ ! -e $parent ]]; do parent="$(dirname -- "$parent")"; done
[[ -d $parent && -w $parent ]] ||
  die "OPT2_CLONE_PARENT ($OPT2_CLONE_PARENT) is not a directory or a path creatable under one: $parent is not a" \
    "writable directory"

# --- Step 1: teardown of the working checkout ------------------------------------------------------------------

step_begin 1 "harness/repro/down.sh in the working checkout"
# The per-command flock lasts until this script exits. down.sh here and the clone's up.sh, test-all.sh and down.sh run
# under it through OPT2_LOCK_FLOCK_HELD, so no other command gets between them; down.sh releases the run lock.
lock_acquire clean-checkout-proof
status=0
"$REPRO_DIR/down.sh" >&2 || status=$?
((status == 0)) || die "teardown of the working checkout failed (exit $status, message above); nothing was cloned"
lock_assert_stack_free

COMMIT="$(git -C "$REPO" rev-parse HEAD)" || die "cannot read HEAD of $REPO"
# The environment artefacts are carried over separately, so they do not count as uncommitted changes.
excludes=()
for rel in "${OPT2_ENV_ARTEFACTS[@]}"; do excludes+=(":(exclude)$rel"); done
dirty="$(git -C "$REPO" status --porcelain -- . "${excludes[@]}")" || die "git status failed in $REPO"
if [[ -n $dirty ]]; then
  mapfile -t DIRTY <<<"$dirty"
  printf 'opt2: warning: %d uncommitted path(s) in %s are not part of the proof, which clones commit %s:\n' \
    "${#DIRTY[@]}" "$REPO" "$COMMIT" >&2
  printf '  %s\n' "${DIRTY[@]:0:20}" >&2
fi
step_end 1 "down.sh exit 0; run lock released"

# --- Step 2: clone ---------------------------------------------------------------------------------------------

step_begin 2 "git clone --no-local the current commit"
[[ ! -e $CLONE && ! -e $CLONE_STATE ]] || die "$CLONE or $CLONE_STATE already exists"
git clone --quiet --no-local -- "$REPO" "$CLONE" >&2 || die "git clone --no-local $REPO $CLONE failed"
git -C "$CLONE" -c advice.detachedHead=false checkout --quiet --detach "$COMMIT" ||
  die "cannot check out $COMMIT in $CLONE"
CLONE_COMMIT="$(git -C "$CLONE" rev-parse HEAD)" || die "cannot read HEAD of $CLONE"
# Untracked environment the legacy oracle needs (TestBox for the baseline, the installed theme, local Masa settings);
# the clone's tracked tree stays the commit's.
for rel in "${OPT2_ENV_ARTEFACTS[@]}"; do
  if [[ -e $REPO/$rel && ! -e $CLONE/$rel ]]; then
    mkdir -p -- "$(dirname -- "$CLONE/$rel")"
    cp -a -- "$REPO/$rel" "$CLONE/$rel" || die "cannot copy $REPO/$rel into the clone"
    COPIED+=("$rel")
  fi
done
step_end 2 "cloned and detached at $CLONE_COMMIT; ${#COPIED[@]} environment artefact(s) copied"

# --- Step 3: both commands in the clone ------------------------------------------------------------------------

step_begin 3 "harness/repro/up.sh, then harness/repro/test-all.sh, in the clone"
UP_RC=0
run_in_clone up.sh || UP_RC=$?
if ((UP_RC == 0)); then
  TEST_RC=0
  run_in_clone test-all.sh || TEST_RC=$?
  # test-all.json is tracked as a placeholder, so only a changed file is test-all.sh's output.
  if [[ -f $CLONE/opt2/reports/test-all.json ]] && ! git -C "$CLONE" diff --quiet -- opt2/reports/test-all.json; then
    DIGEST="$(sha256sum -- "$CLONE/opt2/reports/test-all.json" | cut -d' ' -f1)"
  fi
fi
if [[ -f $CLONE_STATE/fixtures.json ]]; then
  FIXTURES_AVAILABLE="$(json_get "$CLONE_STATE/fixtures.json" available 2>/dev/null)" || FIXTURES_AVAILABLE=unknown
  FIXTURES_REASON="$(json_get "$CLONE_STATE/fixtures.json" reason 2>/dev/null)" || FIXTURES_REASON=""
  if [[ $FIXTURES_REASON == null ]]; then FIXTURES_REASON=""; fi
fi
if [[ $UP_RC == 0 ]] && [[ $TEST_RC == 0 || ($TEST_RC == 2 && $FIXTURES_AVAILABLE == false) ]]; then STATUS=pass; fi
step_end 3 "up.sh exit $UP_RC; test-all.sh exit $TEST_RC"

# --- Step 4: record --------------------------------------------------------------------------------------------

step_begin 4 "record the result in opt2/reports/reproducibility.md"
step_end 4 "status $STATUS"
write_report || printf 'opt2: cannot write %s (message above); retrying after the clone teardown\n' "$REPORT" >&2

# --- Step 5: teardown of the clone -----------------------------------------------------------------------------

step_begin 5 "harness/repro/down.sh in the clone"
DOWN_RC=0
run_in_clone down.sh || DOWN_RC=$?
step_end 5 "down.sh exit $DOWN_RC"
# Rewritten so the record carries step 5's timestamps and outcome too.
REPORT_OK=true
write_report || REPORT_OK=false
if [[ $REPORT_OK == false ]]; then printf 'opt2: cannot write %s (message above)\n' "$REPORT" >&2; fi

printf 'clean-checkout proof: %s (up.sh exit %s, test-all.sh exit %s, clone down.sh exit %s); recorded in %s\n' \
  "$STATUS" "$UP_RC" "$TEST_RC" "$DOWN_RC" "$REPORT"
printf 'clone left for inspection: %s (state %s); this checkout stays down until harness/repro/up.sh\n' \
  "$CLONE" "$CLONE_STATE"
[[ $STATUS == pass && $DOWN_RC == 0 && $REPORT_OK == true ]] || exit 1
