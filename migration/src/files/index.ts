/** Legacy file store: stored-object names, per-snapshot manifests, transfer to and removal from content-files, and the feed's manifest diff. */
export {
  buildFileManifest,
  readManifest,
  readManifestPage,
  readManifestNames,
  streamManifest,
  snapshotDatabase,
  readSnapshotSites,
  readSnapshotFiles,
  SUPPORTED_FILE_STORE,
  MANIFEST_PAGE_ROWS,
  FILE_LOOKUP_IDS,
  FileStoreUnsupportedError,
} from './manifest.js';
export type { FilesContext, FileRow, ManifestKey, ManifestEntry, ManifestBuildResult, SkipReason } from './manifest.js';

export { transferFiles, planObjects, removeDroppedObjects, FileHashMismatchError } from './transfer.js';
export type { PlannedObject, PlanOptions, RejectedObject, TransferResult, RemovalResult } from './transfer.js';

export { withSpool } from './spool.js';
export type { Spool } from './spool.js';

export { diffSnapshotManifests, streamChangedEntries, streamDroppedEntries, streamManifestDiff, compareManifestKeys } from './feed.js';
export type { ManifestDiff, ManifestDifference, DiffManifestOptions } from './feed.js';

export {
  STORED_NAME_PATTERN,
  STORED_VARIANTS,
  parseStoredName,
  formatStoredName,
  storePath,
  nameFromStorePath,
  objectKey,
  parseObjectKey,
  InvalidStoredNameError,
} from './names.js';
export type { StoredVariant, StoredName } from './names.js';
