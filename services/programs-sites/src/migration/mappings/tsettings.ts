import { defineMapping } from '@opt2/platform/migration-kit';
import type { Mapping, MappingColumn } from '@opt2/platform/migration-kit';
import { SITE } from '../../repo/tables.js';

// Live tsettings casing and catalog order: core/setup/db/mssql.sql:370-433, then core/mura/dbUpdates 5.0.629-7.1.
// Declared here, not imported from legacy/site-fields.ts, so the mapping depends only on SITE.
const LEGACY_COLUMNS = [
  'SiteID', 'Site', 'MaxNestLevel', 'PageLimit', 'Locking', 'Domain', 'exportLocation', 'FileDir', 'Contact',
  'MailserverIP', 'MailServerUsername', 'MailServerPassword', 'EmailBroadcaster', 'Extranet', 'ExtranetPublicReg',
  'ExtranetPublicRegNotify', 'ExtranetSSL', 'Cache', 'ViewDepth', 'NextN', 'DataCollection', 'columnCount',
  'columnNames', 'primaryColumn', 'publicSubmission', 'archiveDate', 'contactName', 'contactAddress', 'contactCity',
  'contactState', 'contactZip', 'contactEmail', 'contactPhone', 'privateUserPoolID', 'publicUserPoolID', 'orderNo',
  'emailBroadcasterLimit', 'feedManager', 'displayPoolID', 'galleryMainScaleBy', 'galleryMainScale',
  'gallerySmallScaleBy', 'gallerySmallScale', 'galleryMediumScaleBy', 'galleryMediumScale', 'sendLoginScript',
  'mailingListConfirmScript', 'publicSubmissionApprovalScript', 'reminderScript', 'loginURL', 'editProfileURL',
  'CommentApprovalDefault', 'deploy', 'lastDeployment', 'accountActivationScript', 'googleAPIKey',
  'useDefaultSMTPServer', 'theme', 'mailserverSMTPPort', 'mailserverPOPPort', 'mailserverTLS', 'mailserverSSL',
  'siteLocale', 'domainAlias', 'cacheCapacity', 'cacheFreeMemoryThreshold', 'tagline', 'hasChangesets', 'baseID',
  'enforcePrimaryDomain', 'enforceChangesets', 'smallImageHeight', 'smallImageWidth', 'mediumImageHeight',
  'mediumImageWidth', 'largeImageHeight', 'largeImageWidth', 'contentApprovalScript', 'contentRejectionScript',
  'hasComments', 'hasLockableNodes', 'enableLockdown', 'customTagGroups', 'filePoolID', 'categoryPoolID',
  'contentPoolID', 'sendAuthCodeScript', 'reCAPTCHASiteKey', 'reCAPTCHASecret', 'reCAPTCHALanguage', 'JSONApi',
  'useSSL', 'isremote', 'resourceSSL', 'resourceDomain', 'remoteport', 'remotecontext', 'contentPendingScript',
  'contentCanceledScript', 'showDashboard', 'placeholderImgID', 'placeholderImgExt', 'scaffolding',
] as const;

const SITE_TARGETS: ReadonlyMap<string, Omit<MappingColumn, 'legacy'>> = new Map(
  SITE.columns.map(({ name, ...type }): [string, Omit<MappingColumn, 'legacy'>] => [name, { target: name, ...type }]),
);

/** Legacy `tsettings` ↔ `programs_sites.site` mapping; every row is its own site's tenant. */
export const tsettingsMapping: Mapping = defineMapping({
  legacyTable: 'tsettings',
  // Mapping targets are schema-qualified: SITE.unit, not the repository's bare SITE.table.
  targetTable: SITE.unit,
  unit: SITE.unit,
  // A name absent from SITE spreads no type, so defineMapping rejects it with a MappingError naming the column.
  columns: LEGACY_COLUMNS.map((legacy): MappingColumn => ({ legacy, ...SITE_TARGETS.get(legacy.toLowerCase())! })),
  key: SITE.key,
  tenant: { kind: 'site', column: 'SiteID' },
});
