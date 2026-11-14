// Dependencies, acting user, site settings and result shapes shared by the strategies-content domain operations.
import type { UserClaims } from '@opt2/platform/auth';
import type { WriteContext } from '@opt2/platform/migration-kit';
import type { Clock } from '@opt2/platform/service-kit';
import type { TenantDb } from '@opt2/platform/tenancy';
import type { LegacySiteUrlConfig } from '../legacy/content-urls.js';
import { OWNER, type ContentRepository } from '../repo/repository.js';

/** The Masa configBean settings content operations read. */
export interface ContentConfig {
  purgeDrafts: boolean;
  maxArchivedVersions: number;
  loadContentBy: 'filename' | 'urltitle';
  /** configBean `getValue('variations')`, which enables variation targeting. */
  variations: boolean;
  /** Comma list of the extensions admin uploads accept. */
  fmAllowedExtensions: string;
  /** Comma list of the extensions public (front-end) uploads accept. */
  fmPublicAllowedExtensions: string;
  strictExtendedData: boolean;
}

// configBean.cfc:226 and :227 hold the same list.
const FM_DEFAULT_EXTENSIONS =
  '7z,aiff,asf,avi,bmp,csv,doc,docx,eps,fla,flv,gif,gz,gzip,ics,jpeg,jpg,json,key,keynote,mid,mov,mp3,mp4,mpc,mpeg,mpg,numbers,ods,odt,pages,pdf,png,ppt,pptx,ppsx,pxd,qt,ram,rar,rm,rmi,rmvb,rtf,sdc,sitd,swf,sxc,sxw,svg,tar,tgz,tif,tiff,txt,vsd,wav,wma,wmv,xls,xlsx,xml,zip,m4v,less';

/** configBean defaults (configBean.cfc:155-227); `variations` is read with `defaultValue=false` (contentServer.cfc:649). */
export const CONTENT_CONFIG_DEFAULTS: Readonly<ContentConfig> = Object.freeze({
  purgeDrafts: true,
  maxArchivedVersions: 0,
  loadContentBy: 'filename',
  variations: false,
  fmAllowedExtensions: FM_DEFAULT_EXTENSIONS,
  fmPublicAllowedExtensions: FM_DEFAULT_EXTENSIONS,
  strictExtendedData: true,
});

/** What every domain operation runs against. */
export interface DomainDeps {
  db: TenantDb;
  repository: ContentRepository;
  clock: Clock;
  config: ContentConfig;
}

/** The acting user of an operation, built only by `actorFromClaims`. */
export interface Actor {
  /** Masa `UserID`; '' when anonymous. */
  userId: string;
  /** Legacy `session.mura.fname & " " & session.mura.lname`, the source of `lastUpdateBy`; supplied by the caller. */
  fullName: string;
  isLoggedIn: boolean;
  s2: boolean;
  roles: readonly string[];
  /** Legacy site id of the token; '' when anonymous. */
  siteId: string;
  /** Tenant UUID of the token; '' when anonymous. */
  tenantId: string;
  sessionId?: string;
}

/** The actor for verified `claims`, or the anonymous actor when there are none. */
export function actorFromClaims(claims: UserClaims | undefined, fullName: string): Actor {
  if (claims === undefined) {
    return { userId: '', fullName, isLoggedIn: false, s2: false, roles: [], siteId: '', tenantId: '' };
  }
  return {
    userId: claims.sub,
    fullName,
    isLoggedIn: true,
    s2: claims.s2,
    roles: claims.roles,
    siteId: claims.site,
    tenantId: claims.tid,
    sessionId: claims.sid,
  };
}

/** Site settings the domain needs that `content.tenant_registry` does not hold; the route layer supplies them. */
export interface SiteContentSettings {
  siteId: string;
  /** settingsBean `site`, the site's display name. */
  site: string;
  /** settingsBean `locking`: 'None', 'top' or 'all' (legacy default 'None', settingsBean.cfc:183). */
  locking: string;
  contentApprovalScript: string;
  contentRejectionScript: string;
  contentPendingScript: string;
  contentCanceledScript: string;
  contactEmail: string;
  mailServerUsernameEmail?: string;
  /** settingsBean `commentApprovalDefault`; the legacy default 1 (settingsBean.cfc:141) applies when omitted. */
  commentApprovalDefault?: number;
  urls: LegacySiteUrlConfig;
}

/** A mail legacy would send; operations return it and never send it. */
export interface MailNotice {
  kind: 'approval' | 'comment-subscriber' | 'content-notify';
  to: string;
  from: string;
  subject: string;
  body: string;
  siteId: string;
}

/** Field errors keyed as legacy keys them; insertion order is legacy's error-struct order. */
export type LegacyErrors = Record<string, string>;

/** An operation's value with the legacy errors and mail notices it produced. */
export interface DomainResult<T> {
  value: T;
  errors: LegacyErrors;
  notices: MailNotice[];
}

/** The changelog actor of a write made for `actor`; origin stays the platform default (`target`). */
export function writeContextFor(actor: Actor, requestId?: string): WriteContext {
  return { actorUserId: actor.userId || undefined, actorService: OWNER, requestId };
}

/** Raised where a legacy path would `render404()`; routes answer it with the legacy 404 response. */
export class ContentNotFoundError extends Error {
  override readonly name: string = 'ContentNotFoundError';

  constructor(message = 'Content not found') {
    super(message);
  }
}

// Deliberately not a LegacyApiError: service-kit's error handler answers unrecognised errors with the legacy 500
// (the `server_error` envelope on API routes), as ACF does for a call to a missing function.
/** Raised where legacy calls a CFC function that does not exist (e.g. JSON API `submitForm`). */
export class UndefinedLegacyMethodError extends Error {
  override readonly name: string = 'UndefinedLegacyMethodError';

  constructor(readonly method: string) {
    super(`The method ${method} was not found.`);
  }
}
