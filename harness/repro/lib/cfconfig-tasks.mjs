#!/usr/bin/env node
// Captures, pauses and filters the ColdFusion scheduled tasks of `box cfconfig export` documents, without jq.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const USAGE = `Usage: node cfconfig-tasks.mjs <command> [options]

Commands:
  capture --export <cfconfig.json> --ping <true|false> --webroot <path>
          --out-native <file> --out-cfconfig <file> [--captured-at <iso>]
      Writes the native-tasks.json capture that opt2-migrate scheduler import loads, and an exact
      copy of the export for down.sh; refuses to overwrite a completed capture, and completes one
      interrupted after its copy was written when the export is unchanged.
  pause-all --in <file> --out <file>
      Marks every task Paused (--out may equal --in).
  drop-prefix --prefix <p> --in <file> --out <file>
      Removes every task whose name starts with <p>.
  unpaused --in <file> [--json]
      Prints the names of the tasks that are not paused, one per line or as a JSON array.
  names --in <file> [--prefix <p>] [--json]
      Prints task names, optionally only those starting with <p>.

unpaused and names also read a bridge scheduler.cfm?op=describe answer or a native-tasks.json capture.
Exit status: 0 done, 1 failure, 2 usage.
`;

const COMMANDS = {
  capture: { run: capture, required: ['export', 'ping', 'webroot', 'out-native', 'out-cfconfig'], optional: ['captured-at'] },
  'pause-all': { run: pauseAll, required: ['in', 'out'] },
  'drop-prefix': { run: dropPrefix, required: ['prefix', 'in', 'out'] },
  unpaused: { run: unpaused, required: ['in'], flags: ['json'] },
  names: { run: names, required: ['in'], optional: ['prefix'], flags: ['json'] },
};

// Outputs can hold task credentials, which CFConfig exports decrypted.
const FILE_MODE = 0o600;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
// CFML boolean literals, as Masa's isBoolean(ping) check reads them.
const PING_VALUES = new Map([
  ['true', true],
  ['yes', true],
  ['false', false],
  ['no', false],
]);
const LUCEE_MONITOR_TASK = 'siteMonitor';
const MONITOR_URL_PART = '/_api/sitemonitor/';

/** Invalid command line; exits 2. */
class UsageError extends Error {}

/** Unusable input or output file; exits 1. */
class InputError extends Error {}

/** Parses `<command> --name value … --flag` against COMMANDS; every option value must be non-empty. */
function parseCommandLine(argv) {
  const [command, ...rest] = argv;
  if (command === undefined || !Object.hasOwn(COMMANDS, command)) {
    throw new UsageError(command === undefined ? 'missing command' : `unknown command ${command}`);
  }
  const { required, optional = [], flags = [] } = COMMANDS[command];
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const name = rest[i].startsWith('--') ? rest[i].slice(2) : '';
    if (Object.hasOwn(opts, name)) throw new UsageError(`--${name} given twice`);
    if (flags.includes(name)) {
      opts[name] = true;
    } else if (required.includes(name) || optional.includes(name)) {
      i += 1;
      if (rest[i] === undefined || rest[i] === '') throw new UsageError(`--${name} needs a value`);
      opts[name] = rest[i];
    } else {
      throw new UsageError(`unexpected argument ${rest[i]}`);
    }
  }
  const missing = required.filter((name) => opts[name] === undefined);
  if (missing.length > 0) throw new UsageError(`missing ${missing.map((name) => `--${name}`).join(', ')}`);
  return { run: COMMANDS[command].run, opts };
}

/** True for a JSON object that is not an array. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads and parses a JSON file; a parse error names only the file, because the text can hold task passwords. */
function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new InputError(`cannot read ${file}: ${error.code ?? error.message}`);
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new InputError(`${file} is not valid JSON`);
  }
}

/** A task's name: its `task` field, else its struct key without the `group:` prefix. */
function taskName(entry, key) {
  if (typeof entry.task === 'string' && entry.task !== '') return entry.task;
  return key === undefined ? '' : key.slice(key.indexOf(':') + 1);
}

/** True when a task is paused: CFConfig `status` Paused, else the boolean `paused` of older exports and task lists. */
function isPaused(entry) {
  if (typeof entry.status === 'string') return entry.status.toLowerCase() === 'paused';
  return entry.paused === true;
}

/**
 * Reads a CFConfig export, a bridge describe answer or a native capture (both: a top-level `tasks` array).
 * @returns `{doc, taskList, tasks}`, each task `{key, entry, name}`; `key` is the struct key of a CFConfig struct collection.
 */
function readTasks(file) {
  const doc = readJson(file);
  if (!isRecord(doc)) throw new InputError(`${file} is not a JSON object`);
  const taskList = Array.isArray(doc.tasks);
  const collection = taskList ? doc.tasks : doc.scheduledTasks;
  const label = taskList ? 'tasks' : 'scheduledTasks';
  let entries;
  if (collection === undefined) {
    entries = [];
  } else if (Array.isArray(collection)) {
    entries = collection.map((entry, index) => ({ key: undefined, entry, where: `${label}[${index}]` }));
  } else if (isRecord(collection)) {
    entries = Object.entries(collection).map(([key, entry]) => ({ key, entry, where: `${label}[${JSON.stringify(key)}]` }));
  } else {
    throw new InputError(`${file}: ${label} is neither an object nor an array`);
  }
  const tasks = entries.map(({ key, entry, where }) => {
    const name = isRecord(entry) ? taskName(entry, key) : '';
    if (name === '') throw new InputError(`${file}: ${where} is not a named task`);
    return { key, entry, name };
  });
  return { doc, taskList, tasks };
}

/** Reads a CFConfig export for capture or a transform; task lists are refused, since CFConfig cannot import them. */
function readCfconfig(file) {
  const loaded = readTasks(file);
  if (loaded.taskList) {
    throw new InputError(`${file} is a task list (bridge describe answer or native capture), not a CFConfig export`);
  }
  return loaded;
}

/** `doc` with its scheduledTasks replaced by `tasks`, in the collection's original form and position. */
function withTasks(doc, tasks) {
  if (doc.scheduledTasks === undefined) return doc;
  const scheduledTasks = Array.isArray(doc.scheduledTasks)
    ? tasks.map((task) => task.entry)
    : Object.fromEntries(tasks.map((task) => [task.key, task.entry]));
  return { ...doc, scheduledTasks };
}

/** A CFConfig value in the bridge wire form: a string, `""` when absent. */
function wireString(value) {
  return value === undefined || value === null ? '' : String(value);
}

/**
 * One CFConfig task in the bridge wire shape that migration/src/scheduler/state.ts validates.
 * Every field is a string, as `nativeTaskSchema` requires, except the boolean `paused`.
 */
function nativeTask({ entry, name }) {
  return {
    task: name,
    group: wireString(entry.group) || 'default',
    url: wireString(entry.url ?? entry.URL),
    port: wireString(entry.httpPort ?? entry.port),
    interval: wireString(entry.interval),
    startDate: wireString(entry.startDate),
    startTime: wireString(entry.startTime),
    requestTimeOut: wireString(entry.requestTimeOut),
    operation: wireString(entry.operation) || 'HTTPRequest',
    paused: isPaused(entry),
  };
}

/** Name of the first task that is Masa's site monitor, by its ACF or Lucee task name, then by its URL; null when none. */
function siteMonitorTaskName(tasks, webroot) {
  const monitorNames = new Set([`${webroot.replace(/\/+$/, '')}/index.cfm/_api/sitemonitor/`, LUCEE_MONITOR_TASK]);
  const found =
    tasks.find((task) => monitorNames.has(task.task)) ??
    tasks.find((task) => task.url.toLowerCase().includes(MONITOR_URL_PART));
  return found?.task ?? null;
}

/** Writes `value` as 2-space JSON to a new temp file beside `file`, flushed to disk; returns the temp path. */
function writeTemp(file, value) {
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${suffix}.tmp`);
  const fd = fs.openSync(temp, 'wx', FILE_MODE);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  } finally {
    fs.closeSync(fd);
  }
  return temp;
}

/** Atomically replaces `file` with `value`. */
function writeReplace(file, value) {
  const temp = writeTemp(file, value);
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * Publishes `value` as the new file `file` by hard-linking a flushed temp file, which, unlike rename, fails on an existing target.
 * @returns false when `file` already exists.
 */
function linkNew(file, value) {
  const temp = writeTemp(file, value);
  try {
    fs.linkSync(temp, file);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/** Flushes directory `dir`, so the files linked into it survive a crash. */
function syncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** True when `a` and `b` are the same JSON value, object keys in any order. */
function sameJson(a, b) {
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, i) => sameJson(item, b[i]));
  if (!isRecord(a)) return a === b;
  if (!isRecord(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]));
}

/** True when `file` holds `value` as JSON, object keys in any order; false when it is unreadable or holds anything else. */
function holdsJson(file, value) {
  try {
    return sameJson(readJson(file), value);
  } catch (error) {
    if (error instanceof InputError) return false;
    throw error;
  }
}

/** Prints `list` one name per line, or as one JSON array line. */
function printNames(list, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(list)}\n`);
  } else if (list.length > 0) {
    process.stdout.write(`${list.join('\n')}\n`);
  }
}

/**
 * `capture`: the verbatim CFConfig copy, then the native-tasks.json capture derived from it, which marks completion.
 * A copy left without its capture is kept and completed when it holds the same export; a completed capture is never overwritten.
 */
function capture(opts) {
  const originalPing = PING_VALUES.get(opts.ping.toLowerCase());
  if (originalPing === undefined) throw new UsageError('--ping must be true or false');
  const capturedAt = opts['captured-at'] ?? new Date().toISOString();
  if (!ISO_DATETIME.test(capturedAt) || Number.isNaN(Date.parse(capturedAt))) {
    throw new UsageError('--captured-at must be an ISO-8601 date-time with seconds and Z or an offset');
  }
  if (path.resolve(opts['out-native']) === path.resolve(opts['out-cfconfig'])) {
    throw new UsageError('--out-native and --out-cfconfig must differ');
  }
  const nativeFile = opts['out-native'];
  const copyFile = opts['out-cfconfig'];
  if (fs.existsSync(nativeFile)) throw new InputError(`refusing to overwrite ${nativeFile}`);
  const { doc } = readCfconfig(opts.export);
  if (!linkNew(copyFile, doc)) {
    if (!holdsJson(copyFile, doc)) {
      throw new InputError(
        `${copyFile} is left from an interrupted capture of a different export, without ${nativeFile}; remove it to capture again`,
      );
    }
    process.stderr.write(`cfconfig-tasks: ${copyFile} already holds this export; completing its capture\n`);
  }
  syncDir(path.dirname(copyFile));
  const nativeTasks = readCfconfig(copyFile).tasks.map(nativeTask);
  const native = {
    capturedAt,
    originalPing,
    siteMonitorTask: siteMonitorTaskName(nativeTasks, opts.webroot),
    tasks: nativeTasks,
  };
  if (!linkNew(nativeFile, native)) throw new InputError(`refusing to overwrite ${nativeFile}`);
  syncDir(path.dirname(nativeFile));
}

/** `pause-all`: every task Paused, plus `paused: true` where a task carries that legacy flag. */
function pauseAll(opts) {
  const { doc, tasks } = readCfconfig(opts.in);
  const paused = tasks.map((task) => {
    const entry = { ...task.entry, status: 'Paused' };
    if (Object.hasOwn(entry, 'paused')) entry.paused = true;
    return { ...task, entry };
  });
  writeReplace(opts.out, withTasks(doc, paused));
}

/** `drop-prefix`: every task except those whose name starts with the prefix. */
function dropPrefix(opts) {
  const { doc, tasks } = readCfconfig(opts.in);
  writeReplace(opts.out, withTasks(doc, tasks.filter((task) => !task.name.startsWith(opts.prefix))));
}

/** `unpaused`: names of the tasks not paused. */
function unpaused(opts) {
  const { tasks } = readTasks(opts.in);
  printNames(tasks.filter((task) => !isPaused(task.entry)).map((task) => task.name), opts.json === true);
}

/** `names`: task names, optionally filtered by prefix. */
function names(opts) {
  const { tasks } = readTasks(opts.in);
  const prefix = opts.prefix ?? '';
  printNames(tasks.map((task) => task.name).filter((name) => name.startsWith(prefix)), opts.json === true);
}

try {
  const { run, opts } = parseCommandLine(process.argv.slice(2));
  run(opts);
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`cfconfig-tasks: ${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`cfconfig-tasks: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
