# shellcheck shell=bash
# Checkpoint Ck of test-all.sh: takes, restores and verifies the legacy and target state capture and replay start from.

if ! declare -F filestore_tar >/dev/null || ! declare -F operator_env >/dev/null; then
  printf 'opt2: %s\n' 'checkpoint.sh needs common.sh and processes.sh: source them first' >&2
  exit 1
fi

CK_DIR="$OPT2_STATE_DIR/checkpoint"

# --- Private helpers -------------------------------------------------------------------------------------------

# Prints the OPT-2 PostgreSQL schemas, DB_SCHEMAS of harness/src/repro/secrets.ts.
_ck_schemas() {
  printf '%s\n' identity people programs_sites content stub gateway migration
}

# Prints $1 as a double-quoted SQL identifier.
_ck_ident() {
  local value=${1//\"/\"\"}
  printf '"%s"' "$value"
}

# Prints $1 as a single-quoted SQL string literal.
_ck_literal() {
  local value=${1//\'/\'\'}
  printf "'%s'" "$value"
}

# True when $1 equals one of the remaining arguments.
_ck_contains() {
  local item=$1 candidate
  shift
  for candidate in "$@"; do
    if [[ $candidate == "$item" ]]; then return 0; fi
  done
  return 1
}

# Runs psql as the admin PG_USER: no psqlrc, quiet, unaligned, tuples only, stopping at the first error.
_ck_psql() {
  PGPASSWORD="$PG_PASSWORD" PGOPTIONS="" psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$PG_HOST" -p "$PG_PORT" \
    -U "$PG_USER" -d "$PG_DATABASE" "$@"
}

# _ck_pg <tenant|-> <pg_dump|pg_restore> <args…>: runs the tool against PG_DATABASE as the admin PG_USER, with the
# session's app.tenant_id set to <tenant> unless it is `-`.
_ck_pg() {
  local tenant=$1 tool=$2 options=""
  shift 2
  if [[ $tenant != - ]]; then options="-c app.tenant_id=$tenant"; fi
  PGPASSWORD="$PG_PASSWORD" PGOPTIONS="$options" "$tool" -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" "$@"
}

# _ck_restore <tenant|-> <dump> <pg_restore args…>: restores <dump> via _ck_pg, dying with row-free diagnostics only. A
# single-transaction restore that a deadlock with a running process aborted is repeated, up to 5 attempts in all.
_ck_restore() {
  local tenant=$1 dump=$2 err toc line id rest desc names entry code at="" status=0 sqlstate=unclassified
  local attempt attempts=5 delay
  local q='"[^"]*"' word='[A-Za-z_][A-Za-z0-9_$]*'
  local -a ids=()
  local -a descs=("TABLE DATA" "SEQUENCE SET" "SEQUENCE OWNED BY" "FK CONSTRAINT" "CHECK CONSTRAINT" "ROW SECURITY"
    "DEFAULT ACL" TABLE SEQUENCE CONSTRAINT INDEX POLICY DEFAULT SCHEMA FUNCTION COLLATION ACL)
  local -A states=([23505]="duplicate key value violates unique constraint $q"
    [23503]="insert or update on table $q violates foreign key constraint $q"
    [23502]="null value in column $q of relation $q violates not-null constraint"
    [23514]="new row for relation $q violates check constraint $q"
    [42501]="new row violates row-level security policy for table $q"
    [40P01]="deadlock detected")
  shift 2
  for ((attempt = 1; ; attempt++)); do
    status=0
    sqlstate=unclassified
    ids=()
    # --verbose adds the `from TOC entry <id>` line naming the failing entry.
    err="$(_ck_pg "$tenant" pg_restore --verbose "$@" "$dump" 2>&1 >/dev/null)" || status=$?
    if ((status == 0)); then return 0; fi
    while IFS= read -r line; do
      if [[ $line =~ ^pg_restore:\ from\ TOC\ entry\ ([0-9]+)\; ]]; then ids+=("${BASH_REMATCH[1]}"); fi
      [[ $line == "pg_restore: error: "* ]] || continue
      for code in "${!states[@]}"; do
        if [[ $line =~ ERROR:\ +${states[$code]}$ ]]; then sqlstate=$code; fi
      done
    done <<<"$err"
    # The running gateway's heartbeat locks gateway tables in the opposite order to --clean. A deadlock with it rolls
    # the whole single transaction back, so repeating the restore is safe.
    if [[ $sqlstate != 40P01 ]] || ((attempt == attempts)) || ! _ck_contains --single-transaction "$@"; then break; fi
    delay=$((2 ** (attempt - 1)))
    printf 'opt2: pg_restore of %s rolled back after a deadlock (sqlstate 40P01); attempt %s of %s in %ss\n' \
      "$dump" "$((attempt + 1))" "$attempts" "$delay" >&2
    sleep "$delay"
  done
  # The TOC listing, unlike the error output, names each entry's schema.
  if ((${#ids[@]} > 0)) && toc="$(pg_restore -l "$dump" 2>/dev/null)"; then
    while IFS= read -r line; do
      [[ $line =~ ^([0-9]+)\;\ [0-9]+\ [0-9]+\ (.+)$ ]] || continue
      id=${BASH_REMATCH[1]} rest=${BASH_REMATCH[2]}
      _ck_contains "$id" "${ids[@]}" || continue
      for desc in "${descs[@]}"; do
        [[ $rest == "$desc "* ]] || continue
        names=${rest#"$desc "}
        names=${names% *}
        entry=$desc
        if [[ $names =~ ^$word( $word)+$ ]]; then entry+=" ${names%% *}.${names#* }"; fi
        if [[ "$at, " != *", $entry, "* ]]; then at+=", $entry"; fi
        break
      done
    done <<<"$toc"
  fi
  die "pg_restore of $dump failed (exit $status)$at, sqlstate $sqlstate"
}

# Prints `<schema>\t<table>\t<t|f>` (row security enabled) for every table of the OPT-2 schemas, sorted; dies naming
# the schemas that do not exist.
_ck_tables() {
  local schemas missing
  require_env PG_HOST PG_PORT PG_USER PG_PASSWORD PG_DATABASE
  schemas="$(_ck_schemas | paste -sd, -)"
  missing="$(_ck_psql -v schemas="$schemas" <<'SQL'
SELECT s FROM unnest(string_to_array(:'schemas', ',')) AS s
WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = s) ORDER BY 1;
SQL
)" || die "cannot list the schemas of $PG_DATABASE on $PG_HOST:$PG_PORT"
  [[ -z $missing ]] || die "OPT-2 schemas missing from $PG_DATABASE: ${missing//$'\n'/ }"
  _ck_psql -v schemas="$schemas" <<'SQL' || die "cannot list the tables of the OPT-2 schemas in $PG_DATABASE"
SELECT schemaname || chr(9) || tablename || chr(9) || CASE WHEN rowsecurity THEN 't' ELSE 'f' END
FROM pg_catalog.pg_tables WHERE schemaname = ANY (string_to_array(:'schemas', ','))
ORDER BY schemaname COLLATE "C", tablename COLLATE "C";
SQL
}

# _ck_tenants <tables>: prints the tenants the row-security tables can hold, sorted: the nil tenant of tenant-less rows
# and every site and pool tenant of each schema's tenant_registry.
_ck_tenants() {
  local tables=$1 schema table union=""
  # SYSTEM_TENANT_ID of platform/src/tenancy/tenant-id.ts, never registered.
  local system_tenant=00000000-0000-0000-0000-000000000000
  while IFS=$'\t' read -r schema table _; do
    [[ $table == tenant_registry ]] || continue
    union+=" UNION SELECT unnest(ARRAY[tenant_id, public_user_pool_tenant, private_user_pool_tenant, category_pool_tenant,"
    union+=" file_pool_tenant, display_pool_tenant] || coalesce(content_pool_tenants, '{}'::uuid[]))"
    union+=" FROM $(_ck_ident "$schema").tenant_registry"
  done <<<"$tables"
  _ck_psql -c "SET row_security = off; SELECT t::text FROM (SELECT '$system_tenant'::uuid AS t$union) AS x \
WHERE t IS NOT NULL ORDER BY 1"
}

# _ck_checksum_select <label> <tenant label> <qualified table>: prints the SELECT of one checksum line. A digest of row
# digests keeps each table's aggregate small, where one string of all rows can pass PostgreSQL's 1 GB value limit.
_ck_checksum_select() {
  printf "SELECT %s || chr(9) || %s || chr(9) || count(*) || chr(9) || md5(coalesce(string_agg(md5(t::text), '' \
ORDER BY md5(t::text)), '')) FROM %s AS t;\n" "$(_ck_literal "$1")" "$(_ck_literal "$2")" "$3"
}

# Prints the names of the directories directly under Masa's site directory, sorted.
_ck_site_dirs() {
  local site_dir
  site_dir="$(masa_site_dir)"
  [[ -d $site_dir ]] || return 0
  find "$site_dir" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | LC_ALL=C sort
}

# Prints the untracked, non-ignored directories directly under the site directory $1, by name.
_ck_untracked_site_dirs() {
  local site_dir=$1 prefix="" listing entry name
  if [[ $site_dir != "$REPO" ]]; then prefix="${site_dir#"$REPO"/}/"; fi
  listing="$(git -C "$REPO" ls-files --others --exclude-standard --directory -- "$site_dir/")" ||
    die "cannot list the untracked paths under $site_dir"
  while IFS= read -r entry; do
    name=${entry#"$prefix"}
    name=${name%/}
    if [[ -n $name && $name != */* && -d $site_dir/$name ]]; then printf '%s\n' "$name"; fi
  done <<<"$listing"
}

# Prints sorted `<sha256>  ./<path>` lines for every file of the local object storage; nothing when it is absent.
_ck_storage_manifest() {
  local dir="$OPT2_STATE_DIR/storage"
  [[ -d $dir ]] || return 0
  (cd -- "$dir" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum)
}

# Calls scheduler.cfm through bridge-call.mjs and prints its JSON answer.
_ck_scheduler() {
  local origin
  origin="$(legacy_origin)" || exit 1
  node "$LIB_DIR/bridge-call.mjs" scheduler "$@" --origin "$origin"
}

# _ck_diff <what> <expected> <actual>: prints each line only one side holds to stderr; false when the files differ.
_ck_diff() {
  local what=$1 status=0
  diff --unchanged-line-format= --old-line-format="opt2: checkpoint $what differs, Ck:  %L" \
    --new-line-format="opt2: checkpoint $what differs, now: %L" -- "$2" "$3" >&2 || status=$?
  ((status <= 1)) || die "cannot compare $2 with $3"
  return "$status"
}

# Prints ck.json as tab-separated records: `seq <n>`, `takenAt <iso>`, `site <name>` and `dump <tenant> <file>`.
_ck_manifest() {
  local json="$CK_DIR/ck.json"
  [[ -f $json ]] || die "no checkpoint: $json is missing (run checkpoint_take first)"
  # shellcheck disable=SC2016 # JavaScript source
  node -e '
const fail = (message) => { process.stderr.write(`opt2: ${process.argv[1]}: ${message}\n`); process.exit(1); };
let doc;
try { doc = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch (error) { fail(error.message); }
if (!Number.isSafeInteger(doc.seq) || doc.seq < 0) fail("seq is not a snapshot sequence");
if (typeof doc.takenAt !== "string" || Number.isNaN(Date.parse(doc.takenAt))) fail("takenAt is not a time");
const plain = /^[^\t\n/]+$/;
if (!Array.isArray(doc.siteDirs) || doc.siteDirs.some((d) => typeof d !== "string" || !plain.test(d))) fail("bad siteDirs");
const dumps = doc.pg?.tenantDumps;
if (!Array.isArray(dumps) || dumps.some((d) => !plain.test(String(d?.tenant)) || !plain.test(String(d?.file)))) fail("bad pg.tenantDumps");
const lines = [`seq\t${doc.seq}`, `takenAt\t${doc.takenAt}`, ...doc.siteDirs.map((d) => `site\t${d}`),
  ...dumps.map((d) => `dump\t${d.tenant}\t${d.file}`)];
process.stdout.write(`${lines.join("\n")}\n`);
' -- "$json"
}

# --- Checkpoint ------------------------------------------------------------------------------------------------

# Prints `<schema>.<table>\t<tenant>\t<rows>\t<md5>` for every table of the OPT-2 schemas, sorted. A row-security table
# gets one line per tenant of _ck_tenants, read in that tenant's transaction; any other table gets one line with tenant
# `-`, read with row security off, so a policy that would hide rows raises an error instead. Forced row security admits
# one tenant per transaction, hence the tenant column.
checkpoint_checksums() {
  local tables tenants schema table rls tenant name script output i
  local -a labels=() names=()
  tables="$(_ck_tables)" || exit 1
  tenants="$(_ck_tenants "$tables")" || die "cannot read the tenants of the OPT-2 tenant registries"
  script="SET row_security = off;"$'\n'
  while IFS=$'\t' read -r schema table rls; do
    [[ -n $schema ]] || continue
    # Every running gateway rewrites its heartbeat row each second, so this table never holds still.
    if [[ $schema.$table == gateway.instance ]]; then continue; fi
    name="$(_ck_ident "$schema").$(_ck_ident "$table")"
    if [[ $rls == t ]]; then
      labels+=("$schema.$table")
      names+=("$name")
    else
      script+="$(_ck_checksum_select "$schema.$table" - "$name")"$'\n'
    fi
  done <<<"$tables"
  if ((${#names[@]} > 0)); then
    while IFS= read -r tenant; do
      script+="BEGIN; SET LOCAL row_security = on; SET LOCAL app.tenant_id = $(_ck_literal "$tenant");"$'\n'
      for i in "${!names[@]}"; do
        script+="$(_ck_checksum_select "${labels[i]}" "$tenant" "${names[i]}")"$'\n'
      done
      script+="COMMIT;"$'\n'
    done <<<"$tenants"
  fi
  output="$(_ck_psql <<<"$script")" || die "cannot compute the checksums of the OPT-2 tables in $PG_DATABASE"
  [[ -n $output ]] || die "the OPT-2 schemas of $PG_DATABASE hold no tables"
  printf '%s\n' "$output" | LC_ALL=C sort
}

# checkpoint_take <Sk-seq>: records Ck in CK_DIR, background work already suspended: the legacy file store, the ACF tasks,
# the OPT-2 schemas with their checksums and the local object storage; prints one JSON summary line.
checkpoint_take() {
  local seq=${1:?checkpoint_take needs the Sk snapshot sequence} taken_at sha tables tenants schema table rls tenant
  local storage="$OPT2_STATE_DIR/storage" site_list
  local -a dump_args=() rls_args=() dumps=()
  [[ $seq =~ ^[0-9]+$ ]] || die "checkpoint_take: '$seq' is not a snapshot sequence"
  require_env PG_HOST PG_PORT PG_USER PG_PASSWORD PG_DATABASE
  require_cmd psql pg_dump tar sha256sum node box
  # Taken first: restore seeks the subscriptions back to this time.
  taken_at="$(now_iso)"

  log_step ck-take.1 "recreate $CK_DIR"
  ensure_state_dirs
  rm -rf -- "${CK_DIR:?}"
  mkdir -m 0700 -- "$CK_DIR" || die "cannot create $CK_DIR"

  log_step ck-take.2 "legacy file store"
  filestore_tar "$CK_DIR/filestore.tar" || die "cannot write $CK_DIR/filestore.tar"
  filestore_manifest >"$CK_DIR/filestore.manifest" || die "cannot list the legacy file store"
  site_list="$(_ck_site_dirs)" || die "cannot list the directories of $(masa_site_dir)"

  log_step ck-take.3 "ACF scheduled tasks"
  _ck_scheduler describe >"$CK_DIR/scheduler.json" || die "scheduler.cfm describe failed"
  cfconfig_export "$CK_DIR/tasks.cfconfig.json" >&2 || die "cannot export the scheduled tasks"
  node "$LIB_DIR/cfconfig-tasks.mjs" pause-all --in "$CK_DIR/tasks.cfconfig.json" \
    --out "$CK_DIR/tasks.paused.cfconfig.json" || die "cannot pause the scheduled tasks of $CK_DIR/tasks.cfconfig.json"

  log_step ck-take.4 "OPT-2 schemas of $PG_DATABASE"
  tables="$(_ck_tables)" || exit 1
  tenants="$(_ck_tenants "$tables")" || die "cannot read the tenants of the OPT-2 tenant registries"
  while IFS= read -r schema; do dump_args+=(-n "$(_ck_ident "$schema")"); done < <(_ck_schemas)
  while IFS=$'\t' read -r schema table rls; do
    [[ $rls == t ]] || continue
    dump_args+=("--exclude-table-data=$(_ck_ident "$schema").$(_ck_ident "$table")")
    rls_args+=(-t "$(_ck_ident "$schema").$(_ck_ident "$table")")
  done <<<"$tables"
  # Forced row security binds this admin role too and offers no bypass, so those tables' rows are dumped per tenant, as
  # INSERTs, since COPY FROM is refused under row security; target.dump holds everything else.
  _ck_pg - pg_dump --format=custom --strict-names "${dump_args[@]}" -f "$CK_DIR/target.dump" ||
    die "pg_dump of the OPT-2 schemas failed"
  if ((${#rls_args[@]} > 0)); then
    while IFS= read -r tenant; do
      _ck_pg "$tenant" pg_dump --format=custom --data-only --enable-row-security --rows-per-insert=500 "${rls_args[@]}" \
        -f "$CK_DIR/target.$tenant.dump" || die "pg_dump of the row-security tables of tenant $tenant failed"
      dumps+=("$tenant")
    done <<<"$tenants"
  fi
  checkpoint_checksums >"$CK_DIR/checksums.tsv" ||
    die "cannot write the checksums of the OPT-2 tables to $CK_DIR/checksums.tsv"

  log_step ck-take.5 "local object storage"
  if [[ -d $storage ]]; then
    tar -C "$storage" -cf "$CK_DIR/storage.tar" . || die "cannot write $CK_DIR/storage.tar"
  else
    tar -cf "$CK_DIR/storage.tar" --files-from=/dev/null || die "cannot write $CK_DIR/storage.tar"
  fi
  _ck_storage_manifest >"$CK_DIR/storage.manifest" || die "cannot list $storage"

  sha="$(json_get "$REPO/opt2/source-pin.json" sha)" || die "cannot read the pinned SHA from $REPO/opt2/source-pin.json"
  # shellcheck disable=SC2016 # JavaScript source
  node -e '
const fs = require("fs");
const path = require("path");
const [file, seq, takenAt, sourceSha, siteText, tenantText, dumpText, schemaText] = process.argv.slice(1);
const list = (text) => text.split("\n").filter((line) => line !== "");
const doc = {
  seq: Number(seq),
  takenAt,
  sourceSha,
  siteDirs: list(siteText),
  filestore: { tar: "filestore.tar", manifest: "filestore.manifest" },
  scheduler: { describe: "scheduler.json", cfconfig: "tasks.cfconfig.json", paused: "tasks.paused.cfconfig.json" },
  pg: {
    dump: "target.dump",
    tenantDumps: list(dumpText).map((tenant) => ({ tenant, file: `target.${tenant}.dump` })),
    checksums: "checksums.tsv",
    schemas: list(schemaText),
    tenants: list(tenantText),
  },
  storage: { tar: "storage.tar", manifest: "storage.manifest" },
};
fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ taken: true, seq: doc.seq, takenAt, dir: path.dirname(file),
  tenants: doc.pg.tenants.length, tenantDumps: doc.pg.tenantDumps.length })}\n`);
' -- "$CK_DIR/ck.json" "$seq" "$taken_at" "$sha" "$site_list" "$tenants" "$(printf '%s\n' "${dumps[@]}")" \
    "$(_ck_schemas)" || die "cannot write $CK_DIR/ck.json"
}

# Resets legacy and target to Ck: the legacy database from Sk and the file store with ColdFusion stopped, Mailpit emptied,
# ColdFusion restarted with Ck's tasks paused, the OPT-2 schemas and local storage restored, and the subscriptions
# sought back to Ck's time; prints one JSON summary line.
checkpoint_restore() {
  local fields kind first second seq="" taken_at="" storage="$OPT2_STATE_DIR/storage" site_dir output name
  local ck_tasks restore_body="$CK_DIR/scheduler.restore.json" i
  local -a site_dirs=() dump_tenants=() dump_files=() removed=()
  require_env PG_HOST PG_PORT PG_USER PG_PASSWORD PG_DATABASE
  require_cmd box psql pg_restore tar curl node
  [[ -n ${LEGACY_PORT:-} ]] || die "legacy port unknown: set PORT (or OPT2_LEGACY_PORT)"
  fields="$(_ck_manifest)" || exit 1
  while IFS=$'\t' read -r kind first second; do
    case $kind in
      seq) seq=$first ;;
      takenAt) taken_at=$first ;;
      site) site_dirs+=("$first") ;;
      dump)
        dump_tenants+=("$first")
        dump_files+=("$second")
        ;;
    esac
  done <<<"$fields"

  log_step ck-restore.1 "stop ColdFusion"
  legacy_server_ours ||
    die "CommandBox server $LEGACY_SERVER_NAME is not this checkout's: it is not registered with webroot $REPO and" \
      "server home $(legacy_server_home)"
  box server stop name="$LEGACY_SERVER_NAME" </dev/null >&2 || die "box server stop name=$LEGACY_SERVER_NAME failed"
  wait_port_closed "$LEGACY_PORT" 120

  log_step ck-restore.2 "restore the legacy database from snapshot $seq"
  "$MIGRATE" snapshot restore --seq "$seq" >&2 || die "opt2-migrate snapshot restore --seq $seq failed"

  log_step ck-restore.3 "legacy file store"
  filestore_extract "$CK_DIR/filestore.tar" || die "cannot restore the legacy file store"
  site_dir="$(masa_site_dir)"
  output="$(_ck_untracked_site_dirs "$site_dir")" || exit 1
  while IFS= read -r name; do
    if [[ -z $name ]] || _ck_contains "$name" "${site_dirs[@]}"; then continue; fi
    rm -rf -- "${site_dir:?}/$name" || die "cannot remove the site directory $site_dir/$name"
    removed+=("$name")
  done <<<"$output"

  log_step ck-restore.4 "empty Mailpit"
  curl -fsS --connect-timeout 10 --max-time 60 -o /dev/null -X DELETE "$MAILPIT_API_LOCAL/api/v1/messages" ||
    die "DELETE $MAILPIT_API_LOCAL/api/v1/messages failed"

  log_step ck-restore.5 "start ColdFusion with Ck's scheduled tasks, all paused"
  "$LIB_DIR/legacy-start.sh" --tasks-file "$CK_DIR/tasks.paused.cfconfig.json" >&2 ||
    die "legacy-start.sh --tasks-file $CK_DIR/tasks.paused.cfconfig.json failed"

  log_step ck-restore.6 "ACF scheduled tasks"
  # Writes the restore body of Ck's tasks and prints their count.
  # shellcheck disable=SC2016 # JavaScript source
  ck_tasks="$(node -e '
const fs = require("fs");
const [ckFile, bodyFile] = process.argv.slice(1);
const doc = JSON.parse(fs.readFileSync(ckFile, "utf8"));
if (!Array.isArray(doc?.tasks)) throw new Error(`${ckFile} is not a scheduler describe answer`);
fs.writeFileSync(bodyFile, `${JSON.stringify({ tasks: doc.tasks, repoint: false, paused: true })}\n`, { mode: 0o600 });
process.stdout.write(`${doc.tasks.length}\n`);
' -- "$CK_DIR/scheduler.json" "$restore_body")" || die "cannot read the scheduled tasks of $CK_DIR/scheduler.json"
  if [[ $ck_tasks != 0 ]]; then
    _ck_scheduler restore --json "@$restore_body" >&2 || die "scheduler.cfm restore failed"
  fi

  log_step ck-restore.7 "OPT-2 schemas of $PG_DATABASE"
  # windows.json keeps the windows, the start-up one above included, that the restore drops from migration.write_window.
  "$MIGRATE" window report >&2 || die "opt2-migrate window report failed"
  _ck_restore - "$CK_DIR/target.dump" --clean --if-exists --single-transaction --exit-on-error
  for i in "${!dump_files[@]}"; do
    _ck_restore "${dump_tenants[i]}" "$CK_DIR/${dump_files[i]}" --data-only --enable-row-security --single-transaction \
      --exit-on-error
  done

  log_step ck-restore.8 "local object storage"
  mkdir -p -- "$storage" || die "cannot create $storage"
  find "$storage" -mindepth 1 -delete || die "cannot empty $storage"
  tar -C "$storage" -xpf "$CK_DIR/storage.tar" || die "cannot restore $storage"

  log_step ck-restore.9 "seek the subscriptions to $taken_at"
  "$OPT2_OPS" seek-subscriptions --to "$taken_at" >&2 || die "opt2-ops seek-subscriptions --to $taken_at failed"

  # shellcheck disable=SC2016 # JavaScript source
  node -e '
const [seq, takenAt, ...removedSiteDirs] = process.argv.slice(1);
process.stdout.write(`${JSON.stringify({ restored: true, seq: Number(seq), takenAt, removedSiteDirs })}\n`);
' -- "$seq" "$taken_at" "${removed[@]}"
}

# Compares the current state with Ck: table checksums, file-store and storage manifests, an empty Mailpit, the ACF tasks
# and a zero-difference reconciliation against Sk. Prints each difference to stderr and one JSON summary line; false on
# any difference.
checkpoint_verify() {
  local fields kind first seq="" taken_at="" now="$CK_DIR/verify" total describe line report status=0
  local -a failed=()
  require_cmd curl node diff
  fields="$(_ck_manifest)" || exit 1
  while IFS=$'\t' read -r kind first _; do
    case $kind in
      seq) seq=$first ;;
      takenAt) taken_at=$first ;;
    esac
  done <<<"$fields"
  rm -rf -- "${now:?}"
  mkdir -m 0700 -- "$now" || die "cannot create $now"

  log_step ck-verify.1 "table checksums"
  checkpoint_checksums >"$now/checksums.tsv" ||
    die "cannot write the checksums of the OPT-2 tables to $now/checksums.tsv"
  _ck_diff checksums "$CK_DIR/checksums.tsv" "$now/checksums.tsv" || failed+=(checksums)

  log_step ck-verify.2 "legacy file store and local object storage"
  filestore_manifest >"$now/filestore.manifest" || die "cannot list the legacy file store"
  _ck_diff "file store" "$CK_DIR/filestore.manifest" "$now/filestore.manifest" || failed+=(filestore)
  _ck_storage_manifest >"$now/storage.manifest" || die "cannot list $OPT2_STATE_DIR/storage"
  _ck_diff storage "$CK_DIR/storage.manifest" "$now/storage.manifest" || failed+=(storage)

  log_step ck-verify.3 "Mailpit"
  total="$(curl -fsS --connect-timeout 10 --max-time 60 "$MAILPIT_API_LOCAL/api/v1/messages?limit=1" | json_get - total)" ||
    die "cannot read the message count of $MAILPIT_API_LOCAL"
  if [[ $total != 0 ]]; then
    printf 'opt2: checkpoint Mailpit holds %s messages, Ck: 0\n' "$total" >&2
    failed+=(mailpit)
  fi

  log_step ck-verify.4 "ACF scheduled tasks"
  describe="$(_ck_scheduler describe)" || die "scheduler.cfm describe failed"
  # Prints the tasks one side lacks and the names of fields that differ; exit 1 on a difference, 3 on unreadable input.
  # shellcheck disable=SC2016 # JavaScript source
  printf '%s' "$describe" | node -e '
const fs = require("fs");
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value !== null && typeof value === "object"
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const byName = (source, where) => {
  let text, doc;
  try { text = fs.readFileSync(source, "utf8"); } catch { process.stderr.write(`opt2: ${where} is unreadable\n`); process.exit(3); }
  try { doc = JSON.parse(text); } catch { doc = undefined; }
  if (!Array.isArray(doc?.tasks)) { process.stderr.write(`opt2: ${where} is not a scheduler describe answer\n`); process.exit(3); }
  return new Map(doc.tasks.map((task) => [String(task.task), { task, text: canonical(task) }]));
};
const ck = byName(process.argv[1], process.argv[1]);
const now = byName(0, "scheduler.cfm describe");
const lines = [];
for (const name of [...new Set([...ck.keys(), ...now.keys()])].sort()) {
  if (!now.has(name)) lines.push(`opt2: checkpoint task ${name} is missing`);
  else if (!ck.has(name)) lines.push(`opt2: checkpoint task ${name} is not in Ck`);
  else if (ck.get(name).text !== now.get(name).text) {
    const [ckTask, nowTask] = [ck.get(name).task, now.get(name).task];
    const fields = [...new Set([...Object.keys(ckTask), ...Object.keys(nowTask)])].sort()
      .filter((key) => canonical(ckTask[key]) !== canonical(nowTask[key]));
    lines.push(`opt2: checkpoint task ${name} differs${fields.length > 0 ? ` in ${fields.join(", ")}` : ""}`);
  }
}
if (lines.length > 0) process.stderr.write(`${lines.join("\n")}\n`);
process.exit(lines.length > 0 ? 1 : 0);
' -- "$CK_DIR/scheduler.json" || status=$?
  case $status in
    0) ;;
    1) failed+=(tasks) ;;
    *) die "cannot compare the scheduled tasks with $CK_DIR/scheduler.json" ;;
  esac

  log_step ck-verify.5 "reconcile against snapshot $seq"
  status=0
  line="$("$MIGRATE" reconcile --point checkpoint)" || status=$?
  ((status <= 1)) || die "opt2-migrate reconcile --point checkpoint failed (exit $status)"
  report="$(printf '%s\n' "$line" | json_get - reportPath)" || die "opt2-migrate reconcile printed no reportPath"
  [[ -f $report ]] || die "the reconciliation report $report does not exist"
  # Prints the snapshot compared and every unit and tenant that differs; exit 1 unless Sk was compared with zero difference.
  # shellcheck disable=SC2016 # JavaScript source
  node -e '
const [file, seq] = process.argv.slice(1);
const report = JSON.parse(require("fs").readFileSync(file, "utf8"));
const lines = [];
if (report.snapshotSeq !== Number(seq)) lines.push(`opt2: checkpoint reconciliation compared snapshot ${report.snapshotSeq}, Ck: ${seq}`);
for (const unit of report.units ?? []) {
  // isZeroDifference of migration/src/reconcile/compare.ts.
  const files = unit.files ?? null;
  const same = unit.legacyCount === unit.targetCount && unit.legacySha256 === unit.targetSha256 && unit.differenceCount === 0 &&
    (files === null || (files.differenceCount === 0 && files.legacyObjects === files.targetObjects));
  const table = unit.legacyTable ?? (files === null ? "no legacy table" : "objects");
  if (!same) lines.push(`opt2: checkpoint unit ${unit.unit} (${table}, tenant ${unit.tenantId}) differs from Sk`);
}
if (report.result !== "zero-difference") lines.push(`opt2: checkpoint reconciliation result is ${report.result}: ${file}`);
if (lines.length > 0) process.stderr.write(`${lines.join("\n")}\n`);
process.exit(lines.length > 0 ? 1 : 0);
' -- "$report" "$seq" || failed+=(reconcile)
  if ((status == 1)) && ! _ck_contains reconcile "${failed[@]}"; then failed+=(reconcile); fi

  # shellcheck disable=SC2016 # JavaScript source
  node -e '
const [seq, takenAt, ...failed] = process.argv.slice(1);
const summary = failed.length === 0 ? { verified: true, seq: Number(seq), takenAt }
  : { verified: false, seq: Number(seq), takenAt, differences: failed };
process.stdout.write(`${JSON.stringify(summary)}\n`);
' -- "$seq" "$taken_at" "${failed[@]}"
  ((${#failed[@]} == 0))
}
