// Legacy site registry for route keys: the ids Masa's settingsManager holds, as the legacy bridge lists them.
import { serializeError } from '@opt2/platform/logging';
import { REFRESH_INTERVAL_MS } from '../cutover/state.js';

/** Logger method the registry uses; Fastify's `app.log` satisfies it. */
export interface SiteRegistryLogger {
  error(obj: object, msg: string): void;
}

/** Collaborators of {@link createSiteRegistry}. */
export interface SiteRegistryDeps {
  /** Registered site ids, read from legacy (`site.cfm?op=list`). */
  list: () => Promise<string[]>;
  logger: SiteRegistryLogger;
}

/** The last loaded legacy site registry and its refresh loop. */
export interface SiteRegistry {
  /** `settingsManager.siteExists` over the snapshot: ids match without case, as struct keys do; `''` never exists. */
  siteExists(siteId: string): boolean;
  /** Loads the snapshot, rejecting when that fails, then refreshes it every `REFRESH_INTERVAL_MS` until `stop`. */
  start(): Promise<void>;
  stop(): void;
  /** Reloads the snapshot now; a failure rejects and keeps the previous snapshot. */
  refresh(): Promise<void>;
}

/** Creates an empty registry; {@link SiteRegistry.start} loads it. */
export function createSiteRegistry(deps: SiteRegistryDeps): SiteRegistry {
  let sites: ReadonlySet<string> = new Set();
  // A load started earlier never replaces the snapshot of one started later.
  let loadsStarted = 0;
  let appliedLoad = 0;
  let running = false;
  let loops = 0;
  let timer: NodeJS.Timeout | undefined;

  const refresh = async (): Promise<void> => {
    const load = ++loadsStarted;
    const ids = await deps.list();
    if (load < appliedLoad) return;
    appliedLoad = load;
    sites = new Set(ids.map((id) => id.toLowerCase()).filter((id) => id !== ''));
  };

  // A tick still running across stop() and start() belongs to the old loop and must not reschedule beside the new one.
  const scheduleRefresh = (loop: number): void => {
    timer = setTimeout(() => {
      void refresh()
        .catch((error: unknown) => {
          deps.logger.error({ error: serializeError(error) }, 'legacy site registry refresh failed; keeping the last snapshot');
        })
        .finally(() => {
          if (running && loop === loops) scheduleRefresh(loop);
        });
    }, REFRESH_INTERVAL_MS);
    timer.unref();
  };

  return {
    siteExists: (siteId) => sites.has(siteId.toLowerCase()),

    async start() {
      if (running) return;
      running = true;
      loops += 1;
      const loop = loops;
      try {
        await refresh();
      } catch (error) {
        if (loop === loops) running = false;
        throw error;
      }
      if (running && loop === loops) scheduleRefresh(loop);
    },

    stop() {
      running = false;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },

    refresh,
  };
}
