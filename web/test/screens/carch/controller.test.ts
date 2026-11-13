// carch controller before() against admin/core/controllers/carch.cfc 15-109: module gate, rc defaults, session effects.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { secure, type GateDecision } from '@/lib/access-gate';
import type { AdminRequest } from '@/lib/request-context';
import { CARCH_OWNER, applyCarchDefaults, carchGate, isAjaxRequest } from '@/screens/carch/controller';
import {
  CARCH_SESSION_MODULE_IDS,
  COMPONENT_MODULE_ID,
  CONTENT_MODULE_ID,
  FORM_MODULE_ID,
  ROOT_CONTENT_ID,
  VARIATION_MODULE_ID,
} from '@/screens/carch/model';
import {
  adminS2Request,
  anonymousRequest,
  editorRequest,
  makeAdminRequest,
  siteAdminRequest,
  type AdminRequestPartial,
} from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';

type Subject = NonNullable<Parameters<typeof makeAdminRequest>[1]>;

// Legacy's whitelist carries this 36-character id, which has no session topid default.
const LONG_VARIATION_ID = '000000000000000000000000000000000099';
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const REFERER = 'http://localhost/admin/?muraAction=cArch.list';
/** `session['m<moduleid>']` defaults of carch.cfc 90-101. */
const LEGACY_TOPS: Readonly<Record<string, string>> = {
  m00000000000000000000000000000000000: '00000000000000000000000000000000001',
  m00000000000000000000000000000000003: '00000000000000000000000000000000003',
  m00000000000000000000000000000000004: '00000000000000000000000000000000004',
  m00000000000000000000000000000000099: '00000000000000000000000000000000099',
};

let restore: () => void;
beforeEach(() => {
  restore = useTestEnv();
});
afterEach(() => {
  restore();
});

const carchRequest = (
  rc: Readonly<Record<string, string>> = {},
  session: AdminRequestPartial['session'] = {},
  subject: Subject = 'admin',
): AdminRequest => makeAdminRequest({ circuit: 'carch', item: 'list', rc, session }, subject);

const gate = async (req: AdminRequest): Promise<GateDecision> => carchGate(req, { secure: () => secure(req) });

describe('carchGate', () => {
  it.each([
    ['admin S2', adminS2Request({ circuit: 'carch', item: 'list' })],
    ['tenant-a site admin', siteAdminRequest('tenant-a', { circuit: 'carch', item: 'list' })],
    ['qa_editor with Site Manager', editorRequest({ circuit: 'carch', item: 'list' })],
  ])('allows %s', async (_name, req) => {
    await expect(gate(req)).resolves.toEqual({ kind: 'allow' });
  });

  it('sends anonymous users through secure()', async () => {
    const req = anonymousRequest({ circuit: 'carch', item: 'list' });
    const decision = await gate(req);
    expect(decision.kind).toBe('redirect');
    expect(decision).toEqual(secure(req));
  });

  it.each([
    ['the referrer', new Headers({ referer: REFERER }), REFERER],
    ['./ without a referrer', new Headers(), './'],
  ])('sends a system user without the module back to %s', async (_case, headers, location) => {
    const req = makeAdminRequest({ circuit: 'carch', item: 'list', headers }, 'systemUser');
    const decision = await gate(req);
    expect(decision).toEqual({ kind: 'redirect', location });
    expect(decision).toEqual(secure(req));
  });

  it('never reads roles from rc', async () => {
    const rc = { s2: '1', roles: 's2,site-admin,m:000', moduleperm: 'true' };
    const req = makeAdminRequest({ circuit: 'carch', item: 'list', rc }, 'systemUser');
    await expect(gate(req)).resolves.toEqual(secure(req));
  });
});

describe('applyCarchDefaults', () => {
  const PAGE_DEFAULTS: Readonly<Record<string, string>> = {
    ajaxrequest: 'false',
    moduleid: CONTENT_MODULE_ID,
    instanceid: '',
    return: '',
    startrow: '1',
    contentid: '',
    ptype: 'Page',
    type: 'Page',
    parenthistid: '',
    notify: '',
    preview: '0',
    size: '20',
    action: '',
    returnURL: '',
    homeID: '',
    objectid: '',
    locking: 'false',
    moduleAssign: '',
    orderno: '0',
    cancelPendingApproval: 'false',
    date1: '',
    date2: '',
    ommitPublishingTab: 'false',
    ommitRelatedContentTab: 'false',
    ommitAdvancedTab: 'false',
    murakeepediting: 'false',
    locknode: 'false',
    frontend: 'false',
    isNav: '0',
    target: '_self',
    searchExclude: '0',
    restricted: '0',
    mobileExclude: '0',
    isLocked: '0',
    forceSSL: '0',
    doCache: '1',
    displayTitle: '0',
    relatedContentSetData: '',
    responseChart: '0',
    parentid: '',
    topid: ROOT_CONTENT_ID,
  };

  it('fills every default of a non-ajax request', () => {
    const { rc } = applyCarchDefaults(carchRequest());
    expect(Object.fromEntries(Object.keys(PAGE_DEFAULTS).map((name) => [name, rc[name]]))).toEqual(PAGE_DEFAULTS);
    expect(rc['datasource']).toBeUndefined();
  });

  it('keeps the admin set-up compactDisplay defaults, which precede the controller', () => {
    const { rc } = applyCarchDefaults(carchRequest());
    expect([rc['compactDisplay'], rc['closeCompactDisplay']]).toEqual(['false', 'false']);
  });

  it('defaults contentHistID to a new CF UUID', () => {
    const first = applyCarchDefaults(carchRequest()).rc['contentHistID'] ?? '';
    const second = applyCarchDefaults(carchRequest()).rc['contenthistid'] ?? '';
    expect(first).toMatch(CF_UUID);
    expect(first).toHaveLength(35);
    expect(second).toMatch(CF_UUID);
    expect(second).not.toBe(first);
  });

  it('never overwrites a supplied value', () => {
    const supplied = { Type: 'File', startrow: '3', contentHistID: 'H', target: '_blank', topid: 'T', compactDisplay: 'true' };
    const { rc } = applyCarchDefaults(carchRequest(supplied));
    expect([rc['type'], rc['startrow'], rc['contenthistid'], rc['target'], rc['topid'], rc['compactdisplay']]).toEqual([
      'File',
      '3',
      'H',
      '_blank',
      'T',
      'true',
    ]);
    expect(Object.keys(rc)).toContain('Type');
  });

  it.each([
    ['ommitPublishingTab', 'true', ['isNav', 'target', 'searchExclude', 'restricted', 'mobileExclude']],
    ['ommitAdvancedTab', 'yes', ['isLocked', 'forceSSL', 'doCache', 'displayTitle']],
    ['ommitRelatedContentTab', '1', ['relatedContentSetData']],
  ])('%s=%s skips its tab defaults', (flag, value, skipped) => {
    const { rc } = applyCarchDefaults(carchRequest({ [flag]: value }));
    expect(skipped.map((name) => rc[name])).toEqual(skipped.map(() => undefined));
    expect(rc['responseChart']).toBe('0');
  });

  it.each([
    ['ommitPublishingTab', 'maybe'],
    ['ajaxrequest', ''],
  ])('fails like CFML for %s=%j', (flag, value) => {
    expect(() => applyCarchDefaults(carchRequest({ [flag]: value }))).toThrow(TypeError);
  });

  it('applies only the first three defaults to an ajax request', () => {
    const req = carchRequest({ ajaxrequest: 'true' }, { moduleid: 'unknown' });
    const out = applyCarchDefaults(req);
    expect([out.rc['ajaxrequest'], out.rc['instanceid'], out.rc['contentHistID'], out.rc['topid']]).toEqual([
      'true',
      '',
      undefined,
      undefined,
    ]);
    expect(out.session).toBe(req.session);
    expect(out.sessionWrites).toBe(req.sessionWrites);
  });

  it('queues the object instance id, module id and module tops it changes, and nothing else', () => {
    const out = applyCarchDefaults(carchRequest({ instanceid: 'I1', moduleid: COMPONENT_MODULE_ID }));
    expect(out.sessionWrites).toEqual({
      muraValues: { objectInstanceId: 'I1' },
      moduleid: COMPONENT_MODULE_ID,
      moduleTopIds: LEGACY_TOPS,
    });
    expect(out.session).toMatchObject({ muraValues: { objectInstanceId: 'I1' }, mura: { objectInstanceId: 'I1' } });
    expect([out.session.keywords, out.session.openSectionList]).toEqual(['', '']);
  });

  it('keeps stored keywords and openSectionList without writing them', () => {
    const out = applyCarchDefaults(carchRequest({}, { keywords: 'news', openSectionList: 'A,B' }));
    expect([out.session.keywords, out.session.openSectionList]).toEqual(['news', 'A,B']);
    expect(Object.keys(out.sessionWrites)).not.toContain('keywords');
    expect(Object.keys(out.sessionWrites)).not.toContain('openSectionList');
  });

  it('keeps earlier session writes and is idempotent', () => {
    const base = carchRequest({ moduleid: FORM_MODULE_ID });
    const out = applyCarchDefaults({ ...base, sessionWrites: { rb: 'en_US' } });
    expect(out.sessionWrites).toEqual({ rb: 'en_US', moduleid: FORM_MODULE_ID, moduleTopIds: LEGACY_TOPS });
    const again = applyCarchDefaults(out);
    expect({ ...again.rc }).toEqual({ ...out.rc });
    expect(again.sessionWrites).toEqual(out.sessionWrites);
  });
});

describe('session object instance and module tops', () => {
  const CONTENT_KEY = `m${CONTENT_MODULE_ID}`;
  const LONG_KEY = `m${LONG_VARIATION_ID}`;

  it.each([
    ['without a topid', {}, LEGACY_TOPS],
    ['with a topid', { topid: 'T1' }, { ...LEGACY_TOPS, [CONTENT_KEY]: 'T1' }],
  ])('writes every module default and the current top on the first request %s', (_case, rc, tops) => {
    const out = applyCarchDefaults(carchRequest(rc));
    expect(out.sessionWrites.moduleTopIds).toEqual(tops);
    expect(out.session.moduleTopIds).toEqual(tops);
  });

  it.each([
    ['absent', {}],
    ['empty', { topid: '' }],
  ])('reuses the stored topid of the module when rc.topid is %s', (_case, rc) => {
    const out = applyCarchDefaults(carchRequest(rc, { moduleTopIds: { [CONTENT_KEY]: 'T9' } }));
    expect(out.rc['topid']).toBe('T9');
    expect(out.sessionWrites.moduleTopIds).toEqual({ ...LEGACY_TOPS, [CONTENT_KEY]: 'T9' });
  });

  it('reuses the topid a request stored for the 36-character id', () => {
    const first = applyCarchDefaults(carchRequest({ moduleid: LONG_VARIATION_ID, topid: 'T36' }));
    const next = applyCarchDefaults(
      carchRequest({ moduleid: LONG_VARIATION_ID }, { moduleid: LONG_VARIATION_ID, moduleTopIds: first.session.moduleTopIds }),
    );
    expect(first.sessionWrites.moduleTopIds?.[LONG_KEY]).toBe('T36');
    expect(next.rc['topid']).toBe('T36');
  });

  it('writes nothing on the ajax path, whatever rc carries', () => {
    const req = carchRequest({ ajaxrequest: 'true', instanceid: 'I1', moduleid: FORM_MODULE_ID, topid: 'T1' });
    const out = applyCarchDefaults(req);
    expect(out.session).toBe(req.session);
    expect(out.sessionWrites).toBe(req.sessionWrites);
  });

  it.each([
    ['no instance id', {}, {}],
    ['the stored instance id', { instanceid: 'I1' }, { objectInstanceId: 'I1' }],
  ])('writes nothing when the session already holds the module, its tops and %s', (_case, rc, muraValues) => {
    const req = carchRequest(rc, { moduleid: CONTENT_MODULE_ID, moduleTopIds: LEGACY_TOPS, muraValues });
    const out = applyCarchDefaults(req);
    expect(out.sessionWrites).toEqual({});
    expect(out.session).toBe(req.session);
  });
});

describe('module id sync and topid', () => {
  it('names the legacy module and home ids', () => {
    expect([CONTENT_MODULE_ID, COMPONENT_MODULE_ID, FORM_MODULE_ID, VARIATION_MODULE_ID, ROOT_CONTENT_ID]).toEqual([
      '00000000000000000000000000000000000',
      '00000000000000000000000000000000003',
      '00000000000000000000000000000000004',
      '00000000000000000000000000000000099',
      '00000000000000000000000000000000001',
    ]);
  });

  it('whitelists the legacy module ids, 36-character entry included', () => {
    expect(CARCH_SESSION_MODULE_IDS).toEqual([
      '00000000000000000000000000000000000',
      LONG_VARIATION_ID,
      '00000000000000000000000000000000003',
      '00000000000000000000000000000000004',
      '00000000000000000000000000000000099',
    ]);
  });

  it.each([
    // [case, rc.moduleid, stored session.moduleid, session.moduleid after, rc.moduleid after, rc.topid after]
    ['unknown session id', undefined, 'unknown', CONTENT_MODULE_ID, CONTENT_MODULE_ID, ROOT_CONTENT_ID],
    ['whitelisted rc id', COMPONENT_MODULE_ID, CONTENT_MODULE_ID, COMPONENT_MODULE_ID, COMPONENT_MODULE_ID, COMPONENT_MODULE_ID],
    ['rc id outside the list', '00000000000000000000000000000000008', FORM_MODULE_ID, FORM_MODULE_ID, FORM_MODULE_ID, FORM_MODULE_ID],
    ['empty rc id', '', VARIATION_MODULE_ID, VARIATION_MODULE_ID, VARIATION_MODULE_ID, VARIATION_MODULE_ID],
    ['numerically equal rc id', '3', COMPONENT_MODULE_ID, COMPONENT_MODULE_ID, '3', COMPONENT_MODULE_ID],
  ])('%s', (_case, rcModuleId, stored, sessionAfter, rcAfter, topId) => {
    const rc: Record<string, string> = rcModuleId === undefined ? {} : { moduleid: rcModuleId };
    const req = carchRequest(rc, { moduleid: stored });
    const out = applyCarchDefaults(req);
    expect([out.session.moduleid, out.rc['moduleid'], out.rc['topid']]).toEqual([sessionAfter, rcAfter, topId]);
    expect(out.sessionWrites.moduleid).toBe(sessionAfter === req.session.moduleid ? undefined : sessionAfter);
  });

  it('replaces an empty topid with the module default', () => {
    expect(applyCarchDefaults(carchRequest({ topid: '' })).rc['topid']).toBe(ROOT_CONTENT_ID);
  });

  it('accepts the 36-character id with a topid', () => {
    const out = applyCarchDefaults(carchRequest({ moduleid: LONG_VARIATION_ID, topid: ROOT_CONTENT_ID }));
    expect([out.session.moduleid, out.rc['moduleid'], out.rc['topid']]).toEqual([
      LONG_VARIATION_ID,
      LONG_VARIATION_ID,
      ROOT_CONTENT_ID,
    ]);
  });

  it('fails as ACF does for the 36-character id without a topid', () => {
    expect(() => applyCarchDefaults(carchRequest({ moduleid: LONG_VARIATION_ID }))).toThrow(
      `Element M${LONG_VARIATION_ID} is undefined in a Java object of type class coldfusion.runtime.MemorySessionScope.`,
    );
  });
});

describe('isAjaxRequest', () => {
  it.each([
    [{ ajaxrequest: 'true' }, true],
    [{ AJAXREQUEST: 'yes' }, true],
    [{ ajaxrequest: '1' }, true],
    [{}, false],
    [{ ajaxrequest: 'false' }, false],
    [{ ajaxrequest: 'no' }, false],
  ])('%j is %s', (rc, expected) => {
    expect(isAjaxRequest(rc)).toBe(expected);
  });
});

describe('CARCH_OWNER', () => {
  it('is strategies-content', () => {
    expect(CARCH_OWNER).toBe('strategies-content');
  });
});
