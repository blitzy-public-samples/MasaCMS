/** Legacy file store: stored-object names, per-snapshot manifests, transfer to content-files and the feed's manifest diff. */
export {
  buildFileManifest,
  readManifest,
  readManifestPage,
  streamManifest,
  snapshotDatabase,
  readSnapshotSites,
  readSnapshotFileOwners,
  SUPPORTED_FILE_STORE,
  MANIFEST_PAGE_ROWS,
  FileStoreUnsupportedError,
} from './manifest.js';
export type { FilesContext, ManifestKey, ManifestEntry, ManifestBuildResult } from './manifest.js';

export { transferFiles, planObjects, FileHashMismatchError } from './transfer.js';
export type { PlannedObject, PlanOptions, TransferResult } from './transfer.js';

export { diffSnapshotManifests, streamManifestDiff, compareManifestKeys } from './feed.js';
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
