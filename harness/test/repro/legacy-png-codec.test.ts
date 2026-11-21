import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureBytes } from '../../src/golden/steps.js';
import { pristineDir, repoPath } from '../../src/lib/paths.js';

/** The engine's JAI Image I/O codecLib plugins: their jars on one classpath, and the directory of their native library. */
interface EngineImageIo {
  classpath: string;
  nativeDir: string;
}

/** What PngCodecProbe prints for one JVM start. */
interface ProbeRun {
  readers: string[];
  writers: string[];
  full: string;
  crop: string;
}

const TEMPLATE = JSON.parse(readFileSync(repoPath('harness/repro/server.json.template'), 'utf8')) as {
  jvm: { javaHome: string; args: string };
};
const JAVA = path.join(TEMPLATE.jvm.javaHome, 'bin', 'java');
/** The template's fixed system properties; an argument holding a placeholder is filled per start. */
const TEMPLATE_PROPERTIES = TEMPLATE.jvm.args.split(/\s+/).filter((arg) => arg.startsWith('-D') && !arg.includes('@'));
const PROBE_SOURCE = repoPath('harness/test/fixtures/java/PngCodecProbe.java');
const JDK_READER = 'com.sun.imageio.plugins.png.PNGImageReader';
const JDK_WRITER = 'com.sun.imageio.plugins.png.PNGImageWriter';
const CODECLIB_WRITER = 'com.sun.media.imageioimpl.plugins.png.CLibPNGImageWriter';
/** Identity hashes drawn before ImageIO loads, one JVM start each. */
const DRAWS = Array.from({ length: 16 }, (_, i) => i);

/** The legacy server home as legacy-start.sh resolves it: OPT2_CF_SERVER_HOME, else the captured server's. */
function serverHome(): string | undefined {
  const configured = process.env.OPT2_CF_SERVER_HOME;
  if (configured !== undefined && configured !== '') return configured;
  try {
    const capture = JSON.parse(readFileSync(path.join(pristineDir(), 'server-capture.json'), 'utf8')) as {
      serverHomeDirectory?: unknown;
    };
    const home = capture.serverHomeDirectory;
    return typeof home === 'string' && home !== '' ? home : undefined;
  } catch {
    // No captured server: no engine to probe.
    return undefined;
  }
}

/** The JAI Image I/O codecLib plugins of the engine in `home`, when it ships them. */
function engineImageIo(home: string | undefined): EngineImageIo | undefined {
  if (home === undefined) return undefined;
  const bundles = path.join(home, 'WEB-INF', 'bundles', 'repo');
  const nativeDir = path.join(home, 'WEB-INF', 'cfusion', 'lib');
  const jai = existsSync(bundles) ? readdirSync(bundles).find((name) => /^jai_imageio-[\d.]+\.jar$/.test(name)) : undefined;
  const wrapper = path.join(nativeDir, 'clibwrapper_jiio.jar');
  if (jai === undefined || !existsSync(wrapper)) return undefined;
  return { classpath: [path.join(bundles, jai), wrapper].join(path.delimiter), nativeDir };
}

const IMAGE_IO = existsSync(JAVA) ? engineImageIo(serverHome()) : undefined;

/** One JVM start of the compiled probe in `dir` over `io`, with `properties`, after `draws` identity hashes. */
function start(io: EngineImageIo, dir: string, properties: readonly string[], draws: number): ProbeRun {
  const out = execFileSync(
    JAVA,
    [
      ...properties,
      `-Djava.library.path=${io.nativeDir}`,
      '-cp',
      [dir, io.classpath].join(path.delimiter),
      'PngCodecProbe',
      path.join(dir, 'fixture.png'),
      String(draws),
    ],
    { encoding: 'utf8', timeout: 60_000 },
  );
  const fields = new Map(
    out
      .trim()
      .split('\n')
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)] as const),
  );
  return {
    readers: (fields.get('readers') ?? '').split(','),
    writers: (fields.get('writers') ?? '').split(','),
    full: fields.get('full') ?? '',
    crop: fields.get('crop') ?? '',
  };
}

describe.runIf(IMAGE_IO !== undefined)('legacy ColdFusion JVM PNG codec, over the engine JAI Image I/O plugins', () => {
  let dir = '';

  // The probe compiled into `dir`, beside the image fixture GS-CO-07 and GS-CO-17 upload.
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'opt2-png-codec-test-'));
    writeFileSync(path.join(dir, 'fixture.png'), fixtureBytes('image-png-8x8'));
    execFileSync(JAVA, ['-m', 'jdk.compiler/com.sun.tools.javac.Main', '-d', dir, PROBE_SOURCE], {
      stdio: 'pipe',
      timeout: 60_000,
    });
  });

  afterAll(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  it('reproduces an unpinned start taking either PNG writer, so a restart changes rendition bytes', () => {
    const runs = DRAWS.map((draws) => start(IMAGE_IO as EngineImageIo, dir, [], draws));
    expect(new Set(runs.map((run) => run.writers[0]))).toEqual(new Set([JDK_WRITER, CODECLIB_WRITER]));
    expect(new Set(runs.map((run) => run.crop)).size).toBeGreaterThan(1);
  });

  it('gives every start with the template properties the JDK PNG reader and writer alone, and the same bytes', () => {
    expect(TEMPLATE_PROPERTIES).toContain('-Dcom.sun.media.imageio.disableCodecLib=true');
    const runs = DRAWS.map((draws) => start(IMAGE_IO as EngineImageIo, dir, TEMPLATE_PROPERTIES, draws));
    for (const run of runs) expect([run.readers, run.writers]).toEqual([[JDK_READER], [JDK_WRITER]]);
    expect(new Set(runs.map((run) => `${run.full} ${run.crop}`)).size).toBe(1);
  });
});
