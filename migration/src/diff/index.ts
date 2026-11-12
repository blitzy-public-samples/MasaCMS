/** Change-feed diffs: keyed row streams, keyless multiset streams and file-store manifests. */
export { diffKeyedStreams, DiffOrderError } from './keyed.js';
export type { KeyedChange, KeyedDiffOptions, RowSource, DiffSide } from './keyed.js';

export { diffMultisetStreams } from './multiset.js';
export type { MultisetChange } from './multiset.js';

export { diffManifests } from './manifest.js';
export type { ManifestChange, ManifestDiffEntry } from './manifest.js';
