/** Data owners: the unit catalog of the ownership file and the client of the owners' internal endpoints. */
export { loadUnitCatalog, UnitCatalogError, UnknownUnitError, UnknownLegacyTableError } from './units.js';
export type {
  UnitCatalog,
  Unit,
  DataOwner,
  LegacyTableOwner,
  LegacyTableTarget,
  ProgramFold,
  LoadUnitCatalogOptions,
} from './units.js';

export { createOwnersClient, OwnerCallError, GateConflict, UNAVAILABLE_STATUSES, isOwnerUnavailable, ENDPOINT_OWNERS } from './client.js';
export type {
  OwnersClient,
  CreateOwnersClientOptions,
  ApplyResult,
  PutObjectResult,
  PutObjectParams,
  ObjectBody,
  FileObject,
  DeleteObjectResult,
  DeletedFileObject,
  ExportParams,
  ChangesParams,
  PositionParams,
  WatermarkWrite,
  SiteMonitorState,
  SiteMonitorStateInput,
  AdoptScheduledTask,
  AdoptScheduledTasksRequest,
  AdoptScheduledTasksResult,
  CancelAdoptedTasksRequest,
  CancelAdoptedTasksResult,
} from './client.js';
