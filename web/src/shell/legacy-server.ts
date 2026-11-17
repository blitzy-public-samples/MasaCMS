// Legacy runtime facts of the nav Version menu, read from the legacy environment record (server-only).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from '@opt2/platform/service-kit';
import { webEnv } from '@/lib/env';
import type { LegacyServerInfo } from './types';

/** `settings.versionMenu` of the record `harness/src/baseline/environment.ts --phase services` writes; other fields are ignored. */
const environmentRecordSchema = z.object({
  settings: z
    .object({
      versionMenu: z
        .object({
          appServerProductName: z.string(),
          appServerVersion: z.string(),
          dbProductName: z.string(),
          dbProductVersion: z.string(),
          javaVersion: z.string().nullable(),
          osName: z.string().nullable(),
          osVersion: z.string().nullable(),
        })
        .nullish(),
    })
    .nullable(),
});

/** `<OPT2_STATE_DIR>/baseline/environment.json`, the record `harness/repro/up.sh` writes once legacy is up. */
const environmentRecordPath = (stateDir: string): string => path.join(stateDir, 'baseline', 'environment.json');

/**
 * The Version menu facts of the legacy server, re-read on each call; null while no record exists (before `up.sh`
 * records the service versions, or where none is kept) or it holds none. An absent Java or OS key reads as `''`.
 * @throws When the record exists but cannot be read or does not match its schema.
 */
export async function loadLegacyServerInfo(): Promise<LegacyServerInfo | null> {
  let text: string;
  try {
    text = await readFile(environmentRecordPath(webEnv().OPT2_STATE_DIR), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const menu = environmentRecordSchema.parse(JSON.parse(text)).settings?.versionMenu;
  if (menu === undefined || menu === null) return null;
  return { ...menu, javaVersion: menu.javaVersion ?? '', osName: menu.osName ?? '', osVersion: menu.osVersion ?? '' };
}
