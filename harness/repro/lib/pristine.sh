# shellcheck shell=bash
# Pristine legacy baseline: one-time server and task captures, the paired database and file-store baseline, its restore.
# Sourced after common.sh, whose helpers every function uses.

# --- Private helpers -------------------------------------------------------------------------------------------

# Dies naming the first given path that already exists, a dangling symlink included.
_pristine_refuse_existing() {
  local file
  for file in "$@"; do
    if [[ -e $file || -L $file ]]; then
      die "refusing to overwrite $file (written once; remove a leftover of an interrupted run to retry)"
    fi
  done
}

# Renames the finished temp file $1 to the artefact $2, refusing an existing artefact.
_pristine_publish() {
  local temp=$1 final=$2
  if [[ -e $final || -L $final ]]; then
    rm -f -- "$temp"
    _pristine_refuse_existing "$final"
  fi
  mv -T -- "$temp" "$final" || die "cannot rename $temp to $final"
}

# Prints $1 as a bracket-quoted SQL Server identifier.
_pristine_sql_name() {
  local value=${1//]/]]}
  printf '[%s]' "$value"
}

# Prints $1 as an N'…' SQL Server string literal.
_pristine_sql_string() {
  local value=${1//\'/\'\'}
  printf "N'%s'" "$value"
}

# Prints the non-empty lines of $1, trimmed.
_pristine_lines() {
  printf '%s\n' "$1" | awk '{ sub(/^[ \t]+/, ""); sub(/[ \t\r]+$/, "") } NF'
}

# True when $1 equals one of the remaining arguments.
_pristine_contains() {
  local item=$1 candidate
  shift
  for candidate in "$@"; do
    if [[ $candidate == "$item" ]]; then return 0; fi
  done
  return 1
}

# Dies unless legacy's port is known and free, i.e. ColdFusion is stopped.
_pristine_require_stopped() {
  [[ -n ${LEGACY_PORT:-} ]] || die "legacy port unknown: set PORT (or OPT2_LEGACY_PORT)"
  assert_port_free "$LEGACY_PORT"
}

# Prints Masa's effective original ping, true or false: isBoolean(ping) and ping, absent meaning the template's false.
_pristine_original_ping() {
  local value
  value="$(masa_setting ping)"
  value="$(printf '%s' "${value,,}" | awk '{ sub(/^[ \t]+/, ""); sub(/[ \t\r]+$/, ""); print }')"
  case $value in
    true | yes) printf 'true\n' ;;
    '' | false | no) printf 'false\n' ;;
    \$\{*\} | \{\{*\}\}) die "the ping setting is an expression Masa evaluates at start-up; set MURA_PING to its value" ;;
    *)
      # CFML isBoolean also accepts numbers (non-zero is true); any other literal is not boolean, so no task.
      if [[ $value =~ ^[+-]?[0-9]*\.?[0-9]+$ && $value =~ [1-9] ]]; then printf 'true\n'; else printf 'false\n'; fi
      ;;
  esac
}

# Prints the names of the directories directly under Masa's site directory, sorted.
_pristine_site_dirs() {
  local site_dir
  site_dir="$(masa_site_dir)"
  [[ -d $site_dir ]] || return 0
  find "$site_dir" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | LC_ALL=C sort
}

# Prints the untracked, non-ignored directories directly under the site directory $1, by name.
_pristine_untracked_site_dirs() {
  local site_dir=$1 prefix="" listing entry name
  if [[ $site_dir != "$REPO" ]]; then prefix="${site_dir#"$REPO"/}/"; fi
  # Ignored directories (.git or node_modules in a root-level site layout) are never candidates.
  listing="$(git -C "$REPO" ls-files --others --exclude-standard --directory -- "$site_dir/")" ||
    die "cannot list the untracked paths under $site_dir"
  while IFS= read -r entry; do
    name=${entry#"$prefix"}
    name=${name%/}
    if [[ -n $name && $name != */* && -d $site_dir/$name ]]; then printf '%s\n' "$name"; fi
  done <<<"$listing"
}

# _pristine_backup_file <file>: verified COPY_ONLY backup of MURA_DATABASE to <file> via a temp name; 3 on Msg 3201.
_pristine_backup_file() {
  local final=$1 temp output db
  _pristine_refuse_existing "$final"
  temp="$final.tmp.$$"
  rm -f -- "$temp"
  db="$(_pristine_sql_name "$MURA_DATABASE")"
  if ! output="$(sqlcmd_legacy --db master -x -Q \
    "BACKUP DATABASE $db TO DISK = $(_pristine_sql_string "$temp") WITH COPY_ONLY, CHECKSUM, INIT")"; then
    rm -f -- "$temp"
    if [[ $output == *'Msg 3201,'* ]]; then return 3; fi
    die "BACKUP DATABASE $MURA_DATABASE to $temp failed: $output"
  fi
  if ! output="$(sqlcmd_legacy --db master -x -Q \
    "RESTORE VERIFYONLY FROM DISK = $(_pristine_sql_string "$temp") WITH CHECKSUM")"; then
    rm -f -- "$temp"
    die "RESTORE VERIFYONLY of $temp failed: $output"
  fi
  _pristine_publish "$temp" "$final"
}

# _pristine_taking_add <record> <path>…: atomically adds artefact paths to the in-progress capture record.
_pristine_taking_add() {
  local record=$1 temp
  shift
  temp="$(mktemp -- "$record.XXXXXX")" || die "cannot create a temp file beside $record"
  # shellcheck disable=SC2016 # JavaScript source
  node -e '
const fs = require("fs");
const [file, database, ...paths] = process.argv.slice(1);
const doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8"))
  : { database, startedAt: new Date().toISOString(), artefacts: [] };
for (const p of paths) if (!doc.artefacts.includes(p)) doc.artefacts.push(p);
process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
' -- "$record" "$MURA_DATABASE" "$@" >"$temp" || {
    rm -f -- "$temp"
    die "cannot write $record"
  }
  mv -f -T -- "$temp" "$record" || {
    rm -f -- "$temp"
    die "cannot rename $temp to $record"
  }
}

# _pristine_taking_discard <record> <artefact>…: removes what an unfinished capture recorded, temp files included,
# then the record; only the given artefacts and SQL Server fallback backups are accepted.
_pristine_taking_discard() {
  local record=$1 output file each
  local -a artefacts=() removed=()
  shift
  # shellcheck disable=SC2016 # JavaScript source
  output="$(node -e '
const fail = (message) => { process.stderr.write(`opt2: ${process.argv[1]}: ${message}\n`); process.exit(1); };
const [file, ...own] = process.argv.slice(1);
let doc;
try { doc = JSON.parse(require("fs").readFileSync(file, "utf8")); } catch (error) { fail(error.message); }
const ours = (p) => typeof p === "string" && (own.includes(p) || /^\/[^\n]*\/opt2-pristine-[^/\n]+\.bak$/.test(p));
if (!Array.isArray(doc.artefacts) || !doc.artefacts.every(ours)) fail("artefacts is not a list of capture artefacts");
process.stdout.write(doc.artefacts.map((p) => `${p}\n`).join(""));
' -- "$record" "$@")" || die "cannot read $record: remove it and the artefacts it lists by hand to take the baseline"
  mapfile -t artefacts <<<"$output"
  for file in "${artefacts[@]}"; do
    [[ -n $file ]] || continue
    # Temp names: .tmp.<pid> (backup file, symlink) and mktemp's 6-character suffix.
    for each in "$file" "$file".tmp.* "$file".??????; do
      if [[ -e $each || -L $each ]]; then
        rm -f -- "$each" || die "cannot remove $each, left by an unfinished pristine capture"
        removed+=("$each")
      fi
    done
  done
  rm -f -- "$record" "$record".?????? || die "cannot remove $record"
  printf 'opt2: an earlier pristine capture did not finish; removed %s, taking the baseline again\n' \
    "${removed[*]:-no artefact}" >&2
}

# _pristine_backup <link> <record>: backs up to <link>, else to SQL Server's backup dir linked from <link>, recording
# that file in <record> first; prints the file.
_pristine_backup() {
  local link=$1 record=$2 status=0 dir real temp
  _pristine_backup_file "$link" || status=$?
  if ((status == 0)); then
    realpath -- "$link"
    return 0
  fi
  ((status == 3)) || die "BACKUP DATABASE $MURA_DATABASE failed"
  dir=${OPT2_MSSQL_BACKUP_DIR:-}
  if [[ -z $dir ]]; then
    dir="$(sqlcmd_legacy --db master -Q \
      "SET NOCOUNT ON; SELECT CAST(SERVERPROPERTY('InstanceDefaultBackupPath') AS nvarchar(4000))")" ||
      die "cannot read SQL Server's default backup directory: $dir"
    dir="$(_pristine_lines "$dir")"
  fi
  [[ $dir == /* ]] || die "no absolute SQL Server backup directory ('$dir'): set OPT2_MSSQL_BACKUP_DIR"
  real="${dir%/}/opt2-pristine-$MURA_DATABASE.bak"
  printf 'opt2: SQL Server cannot write %s; backing up to %s\n' "$link" "$real" >&2
  # A file already there is not this capture's, so it is refused before the record claims the path.
  _pristine_refuse_existing "$real"
  _pristine_taking_add "$record" "$real"
  status=0
  _pristine_backup_file "$real" || status=$?
  ((status == 0)) || die "BACKUP DATABASE $MURA_DATABASE failed: SQL Server cannot write $real either (Msg 3201)"
  temp="$link.tmp.$$"
  rm -f -- "$temp"
  ln -s -- "$real" "$temp" || die "cannot create the symlink $temp"
  _pristine_publish "$temp" "$link"
  printf '%s\n' "$real"
}

# --- One-time captures -----------------------------------------------------------------------------------------

# Records the existing legacy CommandBox server once in server-capture.json; OPT2_CF_* overrides win.
capture_server() {
  local out="$OPT2_PRISTINE_DIR/server-capture.json" list entry target format mappings temp
  local -a from=()
  if [[ -e $out ]]; then return 0; fi
  require_cmd box node
  ensure_state_dirs
  list="$(box server list --json)" || die "box server list --json failed"
  # OPT-2's own server is never the original.
  # shellcheck disable=SC2016 # JavaScript source
  entry="$(printf '%s' "$list" | node -e '
const fs = require("fs");
const path = require("path");
const [wanted, repo, port, ours] = process.argv.slice(1);
const fail = (message) => { process.stderr.write(`opt2: ${message}\n`); process.exit(1); };
const text = fs.readFileSync(0, "utf8");
const parse = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
// Tolerates banner lines CommandBox may print before the JSON array.
const lines = text.split("\n");
const list = parse(text) ?? lines.map((l, i) => (l.trimStart().startsWith("[") ? parse(lines.slice(i).join("\n")) : undefined))
  .find((v) => v !== undefined);
if (!Array.isArray(list)) fail("box server list --json did not print an array");
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const running = (s) => String(s.status ?? "").toLowerCase() === "running";
const pick = (matches) => matches.find(running) ?? matches[0];
const servers = list.filter((s) => s !== null && typeof s === "object" && typeof s.name === "string" && s.name !== "" &&
  s.name.toLowerCase() !== ours.toLowerCase());
let found;
if (wanted !== "") {
  found = servers.find((s) => s.name.toLowerCase() === wanted.toLowerCase());
  if (found === undefined) fail(`OPT2_LEGACY_SERVER_NAME=${wanted} names no CommandBox server other than ${ours}`);
} else {
  found = pick(servers.filter((s) => typeof s.webroot === "string" && s.webroot !== "" && real(s.webroot) === repo)) ??
    (port === "" ? undefined : pick(servers.filter((s) => String(s.port ?? "") === port)));
}
const env = (name) => (process.env[name] ?? "") === "" ? undefined : process.env[name];
if (found === undefined) {
  const missing = ["OPT2_CF_SERVER_HOME", "OPT2_CF_ENGINE", "OPT2_CF_JVM_ARGS"].filter((name) => env(name) === undefined);
  if (missing.length > 0) {
    fail(`no CommandBox server serves ${repo} or listens on port ${port || "(PORT unset)"}: set OPT2_LEGACY_SERVER_NAME ` +
      `to the legacy server name, or set ${missing.join(", ")}`);
  }
}
const nonEmpty = (v) => (typeof v === "string" && v !== "" ? v : null);
const engine = env("OPT2_CF_ENGINE") ?? nonEmpty(found?.cfengine) ??
  (nonEmpty(found?.engineName) && nonEmpty(found?.engineVersion) ? `${found.engineName}@${found.engineVersion}` : null);
const discoveredArgs = typeof found?.JVMargs === "string" && found.JVMargs.trim() !== "" ? found.JVMargs
  : Array.isArray(found?.JVMargsArray) ? found.JVMargsArray.join(" ") : "";
const home = env("OPT2_CF_SERVER_HOME") ?? nonEmpty(found?.serverHomeDirectory);
const formatMatch = engine === null ? null : /^([A-Za-z][A-Za-z0-9-]*)(?:@(\d+))?/.exec(engine);
// CFConfig reads an Adobe server home through its WEB-INF/cfusion directory, as it does for a server name.
const homeTarget = (dir) => (formatMatch?.[1].toLowerCase() !== "adobe" || /(^|\/)WEB-INF\/cfusion\/*$/.test(dir) ? dir
  : path.join(dir, "WEB-INF", "cfusion"));
const portNumber = Number(found?.port);
process.stdout.write(JSON.stringify({
  name: found?.name ?? null,
  wasRunning: found === undefined ? false : running(found),
  serverHomeDirectory: home,
  cfengine: engine,
  jvmArgs: (env("OPT2_CF_JVM_ARGS") ?? discoveredArgs).trim(),
  serverConfigFile: nonEmpty(found?.serverConfigFile),
  webroot: nonEmpty(found?.webroot) === null ? null : real(found.webroot),
  port: found !== undefined && Number.isInteger(portNumber) && portNumber > 0 ? portNumber : null,
  cfconfigTarget: found === undefined || env("OPT2_CF_SERVER_HOME") !== undefined ? homeTarget(home) : found.name,
  cfconfigFormat: formatMatch === null ? null : `${formatMatch[1].toLowerCase()}${formatMatch[2] ? `@${formatMatch[2]}` : ""}`,
}));
' -- "${OPT2_LEGACY_SERVER_NAME:-}" "$REPO" "${LEGACY_PORT:-}" "$LEGACY_SERVER_NAME")" || exit 1

  target="$(printf '%s' "$entry" | json_get - cfconfigTarget)" || die "the server capture has no cfconfigTarget"
  format="$(printf '%s' "$entry" | json_get - cfconfigFormat)" || format=null
  from=("from=$target")
  # A server-home path, unlike a CommandBox server name, needs the engine format.
  if [[ $target == /* && $format != null ]]; then from+=("fromFormat=$format"); fi
  mappings="$(box cfconfig cfmapping list "${from[@]}" --json)" || die "cannot list the CF mappings of $target"

  temp="$(mktemp -- "$out.XXXXXX")" || die "cannot create a temp file beside $out"
  # shellcheck disable=SC2016 # JavaScript source
  printf '%s' "$mappings" | node -e '
const fs = require("fs");
const entry = JSON.parse(process.argv[1]);
const text = fs.readFileSync(0, "utf8");
const start = text.indexOf("{");
let muraWRMMapping = null;
if (start >= 0) {
  let doc;
  try { doc = JSON.parse(text.slice(start)); } catch {
    process.stderr.write("opt2: box cfconfig cfmapping list --json did not print JSON\n");
    process.exit(1);
  }
  for (const [virtual, mapping] of Object.entries(doc)) {
    if (virtual.replace(/\/+$/, "").toLowerCase() !== "/murawrm" || mapping === null || typeof mapping !== "object") continue;
    const key = Object.keys(mapping).find((k) => k.toLowerCase() === "physical");
    if (key !== undefined && typeof mapping[key] === "string" && mapping[key] !== "") muraWRMMapping = mapping[key];
  }
}
const { name, wasRunning, serverHomeDirectory, cfengine, jvmArgs, serverConfigFile, webroot, port } = entry;
const { cfconfigTarget, cfconfigFormat } = entry;
process.stdout.write(`${JSON.stringify({ name, wasRunning, serverHomeDirectory, cfengine, jvmArgs, serverConfigFile, webroot,
  port, muraWRMMapping, cfconfigTarget, cfconfigFormat, capturedAt: new Date().toISOString() }, null, 2)}\n`);
' -- "$entry" >"$temp" || {
    rm -f -- "$temp"
    die "cannot write $out"
  }
  _pristine_publish "$temp" "$out"
  printf 'opt2: captured legacy server %s in %s\n' "$(json_get "$out" cfconfigTarget)" "$out" >&2
}

# Captures the original server's scheduled tasks and Masa's original ping once: native-tasks{,.cfconfig}.json.
capture_native_tasks() {
  local native="$OPT2_PRISTINE_DIR/native-tasks.json" capture="$OPT2_PRISTINE_DIR/server-capture.json"
  local export="$OPT2_STATE_DIR/commandbox/native-export.json" target webroot ping
  if [[ -e $native ]]; then return 0; fi
  ensure_state_dirs
  capture_server
  target="$(json_get "$capture" cfconfigTarget)" || die "$capture has no cfconfigTarget"
  # Masa names its ACF monitor task after the webroot that registered it.
  webroot="$(json_get "$capture" webroot)" || webroot=null
  if [[ $webroot == null ]]; then webroot=$REPO; fi
  # The original server was not started with the bridge key, so ping comes from Masa's own settings.
  ping="$(_pristine_original_ping)" || exit 1
  rm -f -- "$export"
  # A server-home target takes its engine format from the capture.
  cfconfig_export "$export" "$target" >&2 || die "cannot export the scheduled tasks of $target"
  node "$LIB_DIR/cfconfig-tasks.mjs" capture --export "$export" --ping "$ping" --webroot "$webroot" \
    --out-native "$native" --out-cfconfig "$OPT2_PRISTINE_DIR/native-tasks.cfconfig.json" ||
    die "cannot capture the native scheduled tasks of $target"
  # The export holds task credentials decrypted; the pristine copy is the one kept.
  rm -f -- "$export"
}

# --- Pristine baseline -----------------------------------------------------------------------------------------

# Prints the zero counts as JSON when database and scheduler hold Masa alone; else names the reason and returns 1.
pristine_check() {
  local tasks_file="$OPT2_PRISTINE_DIR/native-tasks.cfconfig.json" fresh="" output reason
  local -a schemas=() sites=() tasks=() reasons=()
  if ! output="$(sqlcmd_legacy -Q "SET NOCOUNT ON; SELECT name FROM sys.schemas WHERE name IN ('synthetic','opt2_sync') \
OR name LIKE 'Program[_]%' ORDER BY name")"; then
    printf 'pristine baseline cannot be established: cannot query the schemas of %s: %s\n' "$MURA_DATABASE" "$output" >&2
    return 1
  fi
  mapfile -t schemas < <(_pristine_lines "$output")
  if ! output="$(sqlcmd_legacy -Q "SET NOCOUNT ON; SELECT siteid FROM tsettings WHERE siteid IN \
('umbrella','tenant-a','tenant-b') ORDER BY siteid")"; then
    printf 'pristine baseline cannot be established: cannot query tsettings in %s: %s\n' "$MURA_DATABASE" "$output" >&2
    return 1
  fi
  mapfile -t sites < <(_pristine_lines "$output")

  if [[ ! -f $tasks_file ]]; then
    fresh="$OPT2_STATE_DIR/commandbox/pristine-check-export.json"
    mkdir -p -- "${fresh%/*}"
    rm -f -- "$fresh"
    if ! (cfconfig_export "$fresh") >&2; then
      rm -f -- "$fresh"
      printf 'pristine baseline cannot be established: cannot export the scheduled tasks to check them\n' >&2
      return 1
    fi
    tasks_file=$fresh
  fi
  output="$(node "$LIB_DIR/cfconfig-tasks.mjs" names --in "$tasks_file" --prefix opt2-)" || {
    if [[ -n $fresh ]]; then rm -f -- "$fresh"; fi
    printf 'pristine baseline cannot be established: cannot read the scheduled tasks in %s\n' "$tasks_file" >&2
    return 1
  }
  if [[ -n $fresh ]]; then rm -f -- "$fresh"; fi
  mapfile -t tasks < <(_pristine_lines "$output")

  if ((${#schemas[@]} > 0)); then reasons+=("OPT-2 schemas exist in $MURA_DATABASE: ${schemas[*]}"); fi
  if ((${#sites[@]} > 0)); then reasons+=("seed sites exist in tsettings: ${sites[*]}"); fi
  if ((${#tasks[@]} > 0)); then reasons+=("opt2- scheduled tasks exist: ${tasks[*]}"); fi
  if ((${#reasons[@]} > 0)); then
    reason="$(printf '%s; ' "${reasons[@]}")"
    printf 'pristine baseline cannot be established: %s\n' "${reason%; }" >&2
    return 1
  fi
  printf '{"opt2Schemas":%d,"seedSites":%d,"opt2Tasks":%d}\n' "${#schemas[@]}" "${#sites[@]}" "${#tasks[@]}"
}

# Takes the pristine baseline once, ColdFusion stopped: pristine.bak, filestore.tar, then pristine.json marking it done.
# pristine.taking.json lists the artefacts until then, so a rerun after an unfinished capture discards them first.
pristine_take() {
  local json="$OPT2_PRISTINE_DIR/pristine.json" bak="$OPT2_PRISTINE_DIR/pristine.bak"
  local tar="$OPT2_PRISTINE_DIR/filestore.tar" record="$OPT2_PRISTINE_DIR/pristine.taking.json"
  local checks root rel sha real temp output
  local -a site_dirs=()
  if [[ -e $json ]]; then die "refusing to overwrite $json: the pristine baseline is taken once"; fi
  _pristine_require_stopped
  ensure_state_dirs
  checks="$(pristine_check)" || die "pristine baseline not taken"
  root="$(masa_file_root)" || exit 1
  root="$(realpath -m -- "$root")"
  if [[ $root == "$REPO" ]]; then
    rel=.
  elif [[ $root == "$REPO"/* ]]; then
    rel=${root#"$REPO"/}
  else
    rel=""
  fi
  output="$(_pristine_site_dirs)" || die "cannot list the directories of $(masa_site_dir)"
  mapfile -t site_dirs < <(_pristine_lines "$output")
  sha="$(json_get "$REPO/opt2/source-pin.json" sha)" || die "cannot read the pinned SHA from $REPO/opt2/source-pin.json"
  if [[ -e $record || -L $record ]]; then _pristine_taking_discard "$record" "$bak" "$tar" "$json"; fi
  _pristine_refuse_existing "$bak" "$tar"
  _pristine_taking_add "$record" "$bak" "$tar" "$json"

  real="$(_pristine_backup "$bak" "$record")" || exit 1
  temp="$(mktemp -- "$tar.XXXXXX")" || die "cannot create a temp file beside $tar"
  filestore_tar "$temp" || {
    rm -f -- "$temp"
    die "cannot write the file-store tar $tar"
  }
  _pristine_publish "$temp" "$tar"

  temp="$(mktemp -- "$json.XXXXXX")" || die "cannot create a temp file beside $json"
  # shellcheck disable=SC2016 # JavaScript source
  node -e '
const [sha, database, backupPath, fileRoot, fileRootRelative, checks, ...siteDirs] = process.argv.slice(1);
process.stdout.write(`${JSON.stringify({ sha, takenAt: new Date().toISOString(), database, backupPath, fileRoot,
  fileRootRelative: fileRootRelative === "" ? null : fileRootRelative, siteDirs, checks: JSON.parse(checks) }, null, 2)}\n`);
' -- "$sha" "$MURA_DATABASE" "$real" "$root" "$rel" "$checks" "${site_dirs[@]}" >"$temp" || {
    rm -f -- "$temp"
    die "cannot write $json"
  }
  _pristine_publish "$temp" "$json"
  rm -f -- "$record" || die "cannot remove $record"
  printf 'opt2: pristine baseline of %s taken in %s\n' "$MURA_DATABASE" "$OPT2_PRISTINE_DIR" >&2
}

# Restores database and file store from the baseline, ColdFusion stopped, and drops added site dirs; prints JSON.
pristine_restore() {
  local json="$OPT2_PRISTINE_DIR/pristine.json" fields database backup root rel expected current db name lit disk
  local site_dir output
  local -a values=() site_dirs=() removed=()
  [[ -f $json ]] || die "no pristine baseline: $json is missing"
  _pristine_require_stopped
  # A capture stopped between publishing pristine.json and removing its record leaves the record stale.
  rm -f -- "$OPT2_PRISTINE_DIR/pristine.taking.json" || die "cannot remove $OPT2_PRISTINE_DIR/pristine.taking.json"
  # shellcheck disable=SC2016 # JavaScript source
  fields="$(node -e '
const fail = (message) => { process.stderr.write(`opt2: ${process.argv[1]}: ${message}\n`); process.exit(1); };
let doc;
try { doc = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch (error) { fail(error.message); }
for (const key of ["database", "backupPath", "fileRoot"]) if (typeof doc[key] !== "string" || doc[key] === "") fail(`no ${key}`);
if (doc.fileRootRelative !== null && typeof doc.fileRootRelative !== "string") fail("fileRootRelative is neither a string nor null");
if (!Array.isArray(doc.siteDirs) || doc.siteDirs.some((d) => typeof d !== "string" || !/^[^/\n]+$/.test(d))) fail("bad siteDirs");
// The possibly empty fileRootRelative is never last, so command substitution cannot drop its line.
process.stdout.write(`${[doc.database, doc.backupPath, doc.fileRootRelative ?? "", doc.fileRoot, ...doc.siteDirs].join("\n")}\n`);
' -- "$json")" || exit 1
  mapfile -t values <<<"$fields"
  database=${values[0]} backup=${values[1]} rel=${values[2]} root=${values[3]}
  site_dirs=("${values[@]:4}")
  # RESTORE … WITH REPLACE under another name would reuse the baselined database's files.
  [[ ${database,,} == "${MURA_DATABASE,,}" ]] ||
    die "the pristine baseline is of database $database, not MURA_DATABASE=$MURA_DATABASE"
  [[ -f $backup ]] || die "the pristine backup $backup is missing"

  # A clone restores into its own checkout, so a file store inside the checkout resolves against this one.
  if [[ -n $rel ]]; then expected="$(realpath -m -- "$REPO/$rel")"; else expected=$root; fi
  current="$(masa_file_root)" || exit 1
  current="$(realpath -m -- "$current")"
  [[ $current == "$expected" ]] ||
    die "Masa's file store resolves to $current, but the pristine baseline belongs at $expected"

  db="$(_pristine_sql_name "$MURA_DATABASE")"
  lit="$(_pristine_sql_string "$MURA_DATABASE")"
  disk="$(_pristine_sql_string "$backup")"
  if ! output="$(sqlcmd_legacy --db master -x -Q "IF DB_ID($lit) IS NOT NULL ALTER DATABASE $db SET SINGLE_USER WITH \
ROLLBACK IMMEDIATE; RESTORE DATABASE $db FROM DISK = $disk WITH REPLACE, CHECKSUM, RECOVERY; IF DB_ID($lit) IS NOT NULL \
ALTER DATABASE $db SET MULTI_USER;")"; then
    sqlcmd_legacy --db master -x -Q "IF DB_ID($lit) IS NOT NULL ALTER DATABASE $db SET MULTI_USER" >/dev/null 2>&1 ||
      printf 'opt2: could not return %s to MULTI_USER\n' "$MURA_DATABASE" >&2
    die "RESTORE DATABASE $MURA_DATABASE from $backup failed: $output"
  fi

  mkdir -p -- "$current"
  filestore_extract "$OPT2_PRISTINE_DIR/filestore.tar" || die "cannot restore the file store into $current"

  # Masa creates a directory per site the seed adds; tracked and ignored paths are never touched.
  site_dir="$(masa_site_dir)"
  output="$(_pristine_untracked_site_dirs "$site_dir")" || exit 1
  while IFS= read -r name; do
    if [[ -z $name ]] || _pristine_contains "$name" "${site_dirs[@]}"; then continue; fi
    rm -rf -- "${site_dir:?}/$name" || die "cannot remove the site directory $site_dir/$name"
    removed+=("$name")
  done <<<"$output"

  # shellcheck disable=SC2016 # JavaScript source
  node -e '
const [database, backupPath, ...removedSiteDirs] = process.argv.slice(1);
process.stdout.write(`${JSON.stringify({ restored: true, database, backupPath, removedSiteDirs })}\n`);
' -- "$MURA_DATABASE" "$backup" "${removed[@]}"
}

