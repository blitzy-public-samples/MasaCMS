// `bin` entries of @opt2/platform: committed executable wrappers over the compiled CLIs, mirrored in the lockfile.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(path.join(ROOT, file), 'utf8')) as T;
}

const manifest = await readJson<{ bin: Record<string, string> }>('package.json');
const lockfile = await readJson<{ packages: Record<string, { bin?: Record<string, string> }> }>('package-lock.json');

describe('@opt2/platform bin', () => {
  it.each(Object.entries(manifest.bin))('%s runs %s, an executable wrapper over a compiled CLI', async (_name, target) => {
    expect(target).toMatch(/^bin\//);
    const file = path.join(ROOT, target);
    expect((await stat(file)).mode & 0o111).not.toBe(0);

    const source = await readFile(file, 'utf8');
    expect(source.startsWith('#!/usr/bin/env node\n')).toBe(true);
    const cliDir = /^import \{ main \} from '\.\.\/dist\/([a-z-]+)\/cli\.js';$/m.exec(source)?.[1];
    expect(cliDir).toBeDefined();
    const cli = (await import(`../../src/${cliDir}/cli.ts`)) as { main?: unknown };
    expect(typeof cli.main).toBe('function');
  });

  it('lists the same bin entries in package-lock.json, which npm ci links from', () => {
    expect(lockfile.packages['']?.bin).toEqual(manifest.bin);
  });
});
