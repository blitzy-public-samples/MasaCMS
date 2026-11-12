/** Masa approval-chain ORM tables ↔ the `content.approval_*` units, each row's tenant taken from its own `siteID`. */
import { MappingError, defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn } from '@opt2/platform/migration-kit';
import { APPROVAL_ACTION, APPROVAL_ASSIGNMENT, APPROVAL_CHAIN, APPROVAL_MEMBERSHIP, APPROVAL_REQUEST } from '../../repo/tables.js';
import type { ContentUnitTableDefinition } from '../../repo/tables.js';

/** Mapping columns for `legacy` (live-catalog spelling and order), each with the name and canonical type of its lower-cased column in `definition`. */
function columnsOf(legacyTable: string, definition: ContentUnitTableDefinition, legacy: readonly string[]): MappingColumn[] {
  return legacy.map((name): MappingColumn => {
    const column = definition.columns.find((candidate) => candidate.name === name.toLowerCase());
    if (column === undefined) throw new MappingError(legacyTable, `${definition.unit} has no column ${name.toLowerCase()}`);
    const { name: target, ...type } = column;
    return { legacy: name, target, ...type };
  });
}

/** Whole-table mapping of `legacyTable` onto `definition`, keyed by `key`; a row without a `siteID` loads under the umbrella tenant as an orphan. */
function approvalMapping(legacyTable: string, definition: ContentUnitTableDefinition, legacy: readonly string[], key: string): Mapping {
  return defineMapping({
    legacyTable,
    // defineMapping needs a schema-qualified target: `definition.table` is the repository's bare name, `definition.unit` the qualified one.
    targetTable: definition.unit,
    unit: definition.unit,
    columns: columnsOf(legacyTable, definition, legacy),
    key: [key],
    tenant: { kind: 'site', column: 'siteID' },
  });
}

/** `tapprovalchains` ↔ `content.approval_chain`, keyed by `chainID` [approvalChainBean.cfc:3-12]. */
export const tapprovalchainsMapping: Mapping = approvalMapping(
  'tapprovalchains',
  APPROVAL_CHAIN,
  ['siteID', 'chainID', 'name', 'created', 'lastupdate', 'description', 'lastupdateby', 'lastupdatebyid'],
  'chainID',
);

/** `tapprovalmemberships` ↔ `content.approval_membership`: a chain's approving groups, keyed by `membershipID` [approvalChainMembershipBean.cfc:3-8]. */
export const tapprovalmembershipsMapping: Mapping = approvalMapping(
  'tapprovalmemberships',
  APPROVAL_MEMBERSHIP,
  ['groupID', 'siteID', 'created', 'orderno', 'membershipID', 'chainID'],
  'membershipID',
);

/** `tapprovalassignments` ↔ `content.approval_assignment`, keyed by `assignmentID` [approvalChainAssignmentBean.cfc:3-7]. */
export const tapprovalassignmentsMapping: Mapping = approvalMapping(
  'tapprovalassignments',
  APPROVAL_ASSIGNMENT,
  ['siteID', 'assignmentID', 'contentID', 'exemptID', 'chainID'],
  'assignmentID',
);

/** `tapprovalrequests` ↔ `content.approval_request`, keyed by `requestID` [approvalRequestBean.cfc:3-11]. */
export const tapprovalrequestsMapping: Mapping = approvalMapping(
  'tapprovalrequests',
  APPROVAL_REQUEST,
  ['siteID', 'userID', 'groupID', 'created', 'status', 'contentHistID', 'requestID', 'chainID'],
  'requestID',
);

/** `tapprovalactions` ↔ `content.approval_action`, keyed by the ORM's own spelling `actiontID` [approvalActionBean.cfc:3-13]. */
export const tapprovalactionsMapping: Mapping = approvalMapping(
  'tapprovalactions',
  APPROVAL_ACTION,
  ['siteID', 'actionType', 'comments', 'userID', 'groupID', 'created', 'actiontID', 'requestID', 'parentID', 'chainID'],
  'actiontID',
);
