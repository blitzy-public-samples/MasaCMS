/** Owner availability as the reverse projector sees it: once a call finds an owner unavailable, later calls to it fail at once. */
import { ENDPOINT_OWNERS, isOwnerUnavailable, type OwnersClient } from '../owners/index.js';

/** Owners found unavailable, each with the error of the call that found it. */
export type UnavailableOwners = Map<string, Error>;

/**
 * `owners` rejecting every call to an owner in `unavailable` with its remembered error, without calling it, and remembering
 * the owner of every call that finds it unavailable.
 */
export function guardOwners(owners: OwnersClient, unavailable: UnavailableOwners): OwnersClient {
  const refuseKnown = (owner: string): void => {
    const known = unavailable.get(owner);
    if (known !== undefined) throw known;
  };
  const remember = (owner: string, error: unknown): void => {
    if (isOwnerUnavailable(error)) unavailable.set(owner, error);
  };
  const guarded = async <T>(owner: string, call: () => Promise<T>): Promise<T> => {
    refuseKnown(owner);
    try {
      return await call();
    } catch (error) {
      remember(owner, error);
      throw error;
    }
  };
  return {
    apply: (...args) => guarded(args[0], () => owners.apply(...args)),
    export: (...args) => guarded(args[0], () => owners.export(...args)),
    async *exportPages(...args) {
      refuseKnown(args[0]);
      try {
        yield* owners.exportPages(...args);
      } catch (error) {
        remember(args[0], error);
        throw error;
      }
    },
    changes: (...args) => guarded(args[0], () => owners.changes(...args)),
    position: (...args) => guarded(args[0], () => owners.position(...args)),
    watermark: (...args) => guarded(args[0], () => owners.watermark(...args)),
    putWatermark: (...args) => guarded(args[0], () => owners.putWatermark(...args)),
    gate: (...args) => guarded(args[0], () => owners.gate(...args)),
    putObject: (...args) => guarded(ENDPOINT_OWNERS.putObject, () => owners.putObject(...args)),
    getObject: (...args) => guarded(ENDPOINT_OWNERS.getObject, () => owners.getObject(...args)),
    deleteObject: (...args) => guarded(ENDPOINT_OWNERS.deleteObject, () => owners.deleteObject(...args)),
    getAttachmentObject: (...args) => guarded(ENDPOINT_OWNERS.getAttachmentObject, () => owners.getAttachmentObject(...args)),
    getExportObject: (...args) => guarded(ENDPOINT_OWNERS.getExportObject, () => owners.getExportObject(...args)),
    siteMonitorState: () => guarded(ENDPOINT_OWNERS.siteMonitorState, () => owners.siteMonitorState()),
    putSiteMonitorState: (...args) => guarded(ENDPOINT_OWNERS.putSiteMonitorState, () => owners.putSiteMonitorState(...args)),
    adoptScheduledTasks: (...args) => guarded(ENDPOINT_OWNERS.adoptScheduledTasks, () => owners.adoptScheduledTasks(...args)),
    cancelAdoptedScheduledTasks: (...args) => guarded(ENDPOINT_OWNERS.cancelAdoptedScheduledTasks, () => owners.cancelAdoptedScheduledTasks(...args)),
    queueControl: (...args) => guarded(args[0], () => owners.queueControl(...args)),
  };
}
