// Push-delivery log scope of @opt2/platform/service-kit: the eventId and envelope tenant a request's log lines carry; Fastify-free.
import type { FastifyRequest } from 'fastify';

/** Request slot holding the recorded {@link EventLogScope}; createService decorates it as null. */
export const EVENT_SCOPE = Symbol('opt2.service-kit.event-scope');

/** Event and envelope tenant of a push delivery, for its request's log lines. */
export interface EventLogScope {
  eventId: string;
  /** Envelope tenant; logged only when the request has no verified tenant. */
  tenantId?: string;
}

interface EventScopeState {
  [EVENT_SCOPE]?: EventLogScope | null;
}

/** Binds a push delivery's eventId, and its envelope tenant when valid, to the request's error, warning and completion lines. */
export function recordEventScope(request: FastifyRequest, scope: EventLogScope): void {
  (request as unknown as EventScopeState)[EVENT_SCOPE] = { ...scope };
}

/** The scope recorded on `request`, or null when none was. */
export function eventScopeOf(request: FastifyRequest): EventLogScope | null {
  return (request as unknown as EventScopeState)[EVENT_SCOPE] ?? null;
}
