/** Domain context: actor mapping, configBean defaults, changelog write context and the domain error classes. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { UserClaims } from '@opt2/platform/auth';
import { LegacyApiError } from '@opt2/platform/legacy-compat';
import {
  CONTENT_CONFIG_DEFAULTS,
  ContentNotFoundError,
  UndefinedLegacyMethodError,
  actorFromClaims,
  writeContextFor,
} from '../../src/domain/context.js';

const CONFIG_BEAN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../core/mura/configBean.cfc');
const configBeanSource = readFileSync(CONFIG_BEAN, 'utf8');

/** The literal default `configBean.cfc` assigns to `variables.instance.<name>`. */
function configBeanDefault(name: string): string {
  const match = new RegExp(`<cfset variables\\.instance\\.${name}=(?:'([^']*)'|"([^"]*)"|([^ />]+))\\s*/?>`, 'i').exec(configBeanSource);
  if (match === null) throw new Error(`configBean.cfc has no default for ${name}`);
  return match[1] ?? match[2] ?? match[3] ?? '';
}

const EXTENSIONS =
  '7z,aiff,asf,avi,bmp,csv,doc,docx,eps,fla,flv,gif,gz,gzip,ics,jpeg,jpg,json,key,keynote,mid,mov,mp3,mp4,mpc,mpeg,mpg,numbers,ods,odt,pages,pdf,png,ppt,pptx,ppsx,pxd,qt,ram,rar,rm,rmi,rmvb,rtf,sdc,sitd,swf,sxc,sxw,svg,tar,tgz,tif,tiff,txt,vsd,wav,wma,wmv,xls,xlsx,xml,zip,m4v,less';

const CLAIMS: UserClaims = {
  iss: 'opt2-local-identity',
  aud: 'opt2-local',
  sub: '8A2B4C6D-1E3F-5A7B-9C0D1E2F3A4B5C6D',
  sid: 'session-1',
  tid: '0b5f3c1e-8a7d-5e4f-9c3b-2a1d0e9f8c7b',
  site: 'tenant-a',
  roles: ['system-user', 'm:000'],
  s2: true,
  epoch: 3,
  iat: 1_780_000_000,
  exp: 1_780_000_300,
};

describe('actorFromClaims', () => {
  it('maps verified claims onto the actor', () => {
    expect(actorFromClaims(CLAIMS, 'Ada Lovelace')).toEqual({
      userId: CLAIMS.sub,
      fullName: 'Ada Lovelace',
      isLoggedIn: true,
      s2: true,
      roles: ['system-user', 'm:000'],
      siteId: 'tenant-a',
      tenantId: CLAIMS.tid,
      sessionId: 'session-1',
    });
  });

  it('builds the anonymous actor when there are no claims', () => {
    expect(actorFromClaims(undefined, '')).toEqual({
      userId: '',
      fullName: '',
      isLoggedIn: false,
      s2: false,
      roles: [],
      siteId: '',
      tenantId: '',
    });
  });
});

describe('CONTENT_CONFIG_DEFAULTS', () => {
  it.each([
    ['purgeDrafts', 'purgeDrafts', CONTENT_CONFIG_DEFAULTS.purgeDrafts],
    ['maxArchivedVersions', 'maxArchivedVersions', CONTENT_CONFIG_DEFAULTS.maxArchivedVersions],
    ['loadcontentby', 'loadContentBy', CONTENT_CONFIG_DEFAULTS.loadContentBy],
    ['FMAllowedExtensions', 'fmAllowedExtensions', CONTENT_CONFIG_DEFAULTS.fmAllowedExtensions],
    ['FMPublicAllowedExtensions', 'fmPublicAllowedExtensions', CONTENT_CONFIG_DEFAULTS.fmPublicAllowedExtensions],
    ['strictExtendedData', 'strictExtendedData', CONTENT_CONFIG_DEFAULTS.strictExtendedData],
  ])('%s equals the configBean.cfc default (%s)', (legacyName, _field, value) => {
    expect(String(value)).toBe(configBeanDefault(legacyName));
  });

  it('holds the legacy values verbatim', () => {
    expect(CONTENT_CONFIG_DEFAULTS).toEqual({
      purgeDrafts: true,
      maxArchivedVersions: 0,
      loadContentBy: 'filename',
      variations: false,
      fmAllowedExtensions: EXTENSIONS,
      fmPublicAllowedExtensions: EXTENSIONS,
      strictExtendedData: true,
    });
    expect(Object.isFrozen(CONTENT_CONFIG_DEFAULTS)).toBe(true);
  });
});

describe('writeContextFor', () => {
  it.each([
    ['a signed-in actor', actorFromClaims(CLAIMS, 'Ada Lovelace'), 'req-1', { actorUserId: CLAIMS.sub, actorService: 'strategies-content', requestId: 'req-1' }],
    ['the anonymous actor', actorFromClaims(undefined, ''), undefined, { actorUserId: undefined, actorService: 'strategies-content', requestId: undefined }],
  ])('labels writes for %s', (_label, actor, requestId, expected) => {
    const ctx = writeContextFor(actor, requestId);
    expect(ctx).toStrictEqual(expected);
    expect(ctx.origin).toBeUndefined();
  });
});

describe('domain errors', () => {
  it('ContentNotFoundError is a named Error', () => {
    const err = new ContentNotFoundError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ContentNotFoundError');
    expect(err.message).toBe('Content not found');
    expect(new ContentNotFoundError('no such node').message).toBe('no such node');
  });

  it('UndefinedLegacyMethodError carries the method and is not a LegacyApiError', () => {
    const err = new UndefinedLegacyMethodError('submitForm');
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(LegacyApiError);
    expect(err.name).toBe('UndefinedLegacyMethodError');
    expect(err.method).toBe('submitForm');
    expect(err.message).toContain('submitForm');
  });
});
