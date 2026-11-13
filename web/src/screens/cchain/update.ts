// `cchain.update`: `admin/core/views/cchain/update.cfm` includes edit.cfm, so it is the edit screen (server-only).
import { loadCchainEdit, renderCchainEdit } from './edit';

/** Loads the chain of `rc.chainID` exactly as `cchain.edit` does; an empty id becomes a new CF UUID. */
export const loadCchainUpdate: typeof loadCchainEdit = loadCchainEdit;

/** Renders the edit view; `ctx.req.action` ends in `update`, so its secondary menu is empty. */
export const renderCchainUpdate: typeof renderCchainEdit = renderCchainEdit;
