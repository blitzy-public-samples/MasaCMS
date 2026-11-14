/** The site monitor's scheduled change-set step (changesetManager.publishBySchedule) as a managed Cloud Tasks route. */
import { LegacyApiError } from '@opt2/platform/legacy-compat';
import { z, type FastifyInstance } from '@opt2/platform/service-kit';
import { registerTaskRoute } from '@opt2/platform/tasks';
import { publishScheduledChangesets, type ScheduledPublishDeps, type ScheduledPublishItem } from '../domain/changesets.js';
import type { DomainDeps } from '../domain/context.js';
import type { components } from '../generated/openapi.js';

type SiteMonitorStepPayload = components['schemas']['SiteMonitorStepPayload'];
type JobResult = components['schemas']['JobResult'];

/** Target path of the `content-scheduled-publish` queue. */
export const PUBLISH_SCHEDULED_CHANGESETS_PATH = '/internal/v1/jobs/publish-scheduled-changesets' as const;

/** What the step runs against. */
export interface PublishScheduledChangesetsDeps extends DomainDeps {
  // Required, never defaulted here: the service holds no verified site settings (the registry has only ids, pools and
  // domains), and configBean defaults such as siteIDInURLS=true differ from deployed values, so the composition root supplies them.
  /** Settings of each registered site that has change sets due, which the content saves read. */
  siteFor: ScheduledPublishDeps['siteFor'];
}

/** The contract's `JobResult`, with the change sets the step reached in publish order. */
export interface PublishScheduledChangesetsResult extends JobResult {
  step: 'publishScheduledChangesets';
  changesets: ScheduledPublishItem[];
}

// The contract's LocalTimestamp: wall-clock time without an offset, which Date parses in the process TZ (the legacy zone).
const LOCAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/;

// Only `theTime` is read; a payload without it selects by the injected clock, as the domain does.
const payloadSchema = z.object({
  theTime: z
    .string()
    .regex(LOCAL_TIMESTAMP)
    .refine((text) => !Number.isNaN(Date.parse(text)))
    .optional(),
}) satisfies z.ZodType<Partial<Pick<SiteMonitorStepPayload, 'theTime'>>>;

/** Registers POST `PUBLISH_SCHEDULED_CHANGESETS_PATH`, answering once every due change set of every registered tenant is handled. */
export function registerPublishScheduledChangesets(app: FastifyInstance, deps: PublishScheduledChangesetsDeps): void {
  registerTaskRoute(app, PUBLISH_SCHEDULED_CHANGESETS_PATH, {
    scope: 'system',
    handler: async ({ payload }): Promise<PublishScheduledChangesetsResult> => {
      const parsed = payloadSchema.safeParse(payload);
      if (!parsed.success) throw new LegacyApiError('invalidParameters');
      // The orchestrator's run time is legacy's now(), so a delayed or retried task covers the same change sets.
      const { theTime } = parsed.data;
      const { changesets } = await publishScheduledChangesets({ ...deps, cutoff: theTime === undefined ? undefined : new Date(theTime) });
      return { step: 'publishScheduledChangesets', changesets };
    },
  });
}
