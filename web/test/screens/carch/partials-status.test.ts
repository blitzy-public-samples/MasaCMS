// carch dsp_status.cfm: node lock notice, approval status and calendar notices, against legacy.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CsrfTokens } from '@/lib/csrf';
import { isSafeHtml, toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import {
  status,
  type StatusConflict,
  type StatusContent,
  type StatusContext,
  type StatusLockUser,
  type StatusModel,
} from '@/screens/carch/partials/status';
import { adminS2Request, editorRequest, siteAdminRequest } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';

const CONTENT_ID = 'C1000000-0000-0000-0000000000000001';
const CONTENT_HIST_ID = 'C2000000-0000-0000-0000000000000001';
const OTHER_USER_ID = '5A000000-0000-0000-0000000000000009';

const UNLOCK_CSRF: CsrfTokens = { token: '00000000000000000000000000000001', expires: '260630150000000' };
const APPROVAL_CSRF: CsrfTokens = { token: '00000000000000000000000000000002', expires: '260630150000001' };

const ANN: StatusLockUser = { fname: 'Ann', lname: 'Lee', email: 'ann@example.com' };

const CONTENT: StatusContent = {
  contentId: CONTENT_ID,
  siteId: 'default',
  contentHistId: CONTENT_HIST_ID,
  approvalStatus: '',
  display: 1,
  displayIntervalDesc: '',
  conflicts: [],
};

// `esapiEncode('javascript', contentHistID)`.
const HIST_ID_JS = CONTENT_HIST_ID.replaceAll('-', '\\x2D');

const NOTICE = {
  pending: 'This content version has been sent for approval:',
  rejected: 'This content version has been rejected:',
} as const;

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
});

/** A `tokens`-only renderer recording each requested context; `approvalaction` gets its own pair. */
function recordingCsrf(): { csrf: StatusContext['csrf']; contexts: string[] } {
  const contexts: string[] = [];
  const tokens = (context: string): Promise<CsrfTokens> => {
    contexts.push(context);
    return Promise.resolve(context === 'approvalaction' ? APPROVAL_CSRF : UNLOCK_CSRF);
  };
  return { csrf: { tokens }, contexts };
}

/** A non-lockable model with no approval block; `fields` overrides any member. */
const model = (fields: Partial<StatusModel> = {}): StatusModel => ({
  hasLockableNodes: false,
  stats: {},
  content: CONTENT,
  parentType: 'Folder',
  ...fields,
});

/** A model of `content` overrides under a Calendar parent, with the approval block shown. */
const calendarModel = (content: Partial<StatusContent>): StatusModel =>
  model({ showApprovalStatus: true, parentType: 'Calendar', content: { ...CONTENT, ...content } });

/** The rendered markup and the CSRF contexts requested while rendering it. */
async function render(
  fields: Partial<StatusModel>,
  req: AdminRequest = adminS2Request(),
): Promise<{ markup: string; contexts: string[] }> {
  const { csrf, contexts } = recordingCsrf();
  const html = await status({ req, rb: rbFor(req.session.rb), csrf }, model(fields));
  expect(isSafeHtml(html)).toBe(true);
  return { markup: toString(html), contexts };
}

/** Stats of a node lock held by `lockID`. */
const nodeLock = (lockID: string, lockType = 'node'): StatusModel['stats'] => ({ lockID, lockType });

/** The `jQuery.post` data of the unlock script for `tokens`. */
const unlockPost = (tokens: CsrfTokens, siteId = 'default'): string =>
  [
    'muraAction:"carch.unlockNode",',
    `contentid:"${CONTENT_ID}",`,
    `siteid:"${siteId}",`,
    `csrf_token:'${tokens.token}',`,
    `csrf_token_expires: '${tokens.expires}'`,
  ].join('\n\t\t\t\t\t\t\t\t\t');

/** `text` as a literal regular-expression source. */
const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const UNLOCK_LINK = '<a class="mura-node-unlock" href="#"><i class="mi-unlock"></i> Unlock</a>';
const ELSE_LOCK_SCRIPT =
  "$('.form-actions').hide();\n\t\t\t\tlockedbysomeonelse=true;\n\t\t\t\tsiteManager.doConditionalExit=false;";

describe('status', () => {
  it.each<[string, Partial<StatusModel>]>([
    ['a site without lockable nodes', { stats: nodeLock(OTHER_USER_ID) }],
    ['an unlocked node', { hasLockableNodes: true, stats: nodeLock('') }],
    ['a draft lock', { hasLockableNodes: true, stats: nodeLock(OTHER_USER_ID, 'draft') }],
    ['absent stats', { hasLockableNodes: true }],
  ])('renders nothing for %s without approval status', async (_case, fields) => {
    const { markup, contexts } = await render(fields);
    expect(markup.trim()).toBe('');
    expect(contexts).toEqual([]);
  });

  describe('node locked by the session user', () => {
    it.each<[string, (userId: string) => StatusModel['stats']]>([
      ['the same id', (userId) => nodeLock(userId)],
      ['a lower-cased id', (userId) => nodeLock(userId.toLowerCase())],
      ['an upper-cased lock type', (userId) => nodeLock(userId, 'NODE')],
    ])('notices the lock under %s with the unlock script', async (_case, stats) => {
      const req = adminS2Request();
      const { markup, contexts } = await render({ hasLockableNodes: true, stats: stats(req.session.mura.userID) }, req);
      expect(markup).toContain('<p id="msg-node-locked" class="alert alert-error">\n\t\t\t\t<span>\n');
      expect(markup).toContain(`You've locked this content item and all related versions. ${UNLOCK_LINK}`);
      expect(markup).not.toContain('id="msg-node-locked-else"');
      expect(markup).toContain('confirmDialog(\n\t\t\t\t\t\t\t"Unlock\\x20this\\x20Content\\x20Item\\x3F",');
      expect(markup).toContain(unlockPost(UNLOCK_CSRF));
      expect(markup).not.toContain(ELSE_LOCK_SCRIPT);
      expect(markup).toMatch(/<\/script>\s*$/);
      expect(contexts).toEqual([`${CONTENT_ID}unlocknode`]);
    });
  });

  describe('node locked by someone else', () => {
    it.each<[string, boolean, () => AdminRequest]>([
      ['the super user', true, () => adminS2Request()],
      ['the site admin', true, () => siteAdminRequest()],
      [
        'the site admin on a site its token does not serve, as isAdminUser() reads its own site',
        true,
        () => siteAdminRequest('tenant-b'),
      ],
      ['an editor', false, () => editorRequest()],
    ])('notices the holder to %s, unlock link %s', async (_case, unlockable, request) => {
      const { markup, contexts } = await render(
        { hasLockableNodes: true, stats: nodeLock(OTHER_USER_ID), lockedBy: ANN },
        request(),
      );
      expect(markup).toContain('<p id="msg-node-locked-else" class="alert alert-error">\n\t\t\t\t<span>\n\t\t\t\t\t');
      expect(markup).toContain(
        'This content item and all related versions are locked for editing by Ann Lee.<br>\n\t\t\t\t' +
          '<a href="mailto:ann&#x40;example.com?subject=Content Unlock Request"><i class="mi-envelope"></i> ' +
          'Request Content Lock Release via Email</a>',
      );
      expect(markup).not.toContain('id="msg-node-locked" ');
      expect(markup.includes(` &nbsp; &nbsp;${UNLOCK_LINK}`)).toBe(unlockable);
      expect(markup).toContain(unlockPost(UNLOCK_CSRF));
      expect(markup).toContain(ELSE_LOCK_SCRIPT);
      expect(contexts).toEqual([`${CONTENT_ID}unlocknode`]);
    });

    it.each<[string, StatusLockUser | undefined, string, string]>([
      [
        'encodes the first name as an attribute and the rest as html',
        { fname: 'Mary Ann', lname: "O'Hara <QA>", email: 'o"hara@example.com' },
        'by Mary&#x20;Ann O&#x27;Hara &lt;QA&gt;.<br>',
        'mailto:o&quot;hara&#x40;example.com?subject=',
      ],
      [
        'formats the name list up to its first comma',
        { ...ANN, lname: 'Lee, Jr.' },
        'by Ann Lee.<br>',
        'mailto:ann&#x40;example.com?subject=',
      ],
      ['renders the empty user of an unknown holder', undefined, 'by  .<br>', 'mailto:?subject='],
    ])('%s', async (_case, lockedBy, holder, mailto) => {
      const { markup } = await render({ hasLockableNodes: true, stats: nodeLock(OTHER_USER_ID), lockedBy });
      expect(markup).toContain(`locked for editing ${holder}`);
      expect(markup).toContain(`<a href="${mailto}`);
    });
  });

  describe('approval status', () => {
    it('omits the modal container and scripts when the view defines no showApprovalStatus', async () => {
      const { markup, contexts } = await render({ content: { ...CONTENT, approvalStatus: 'Pending' } });
      expect(markup).not.toContain('approvalModalContainer');
      expect(markup).not.toContain('viewStatusInfo');
      expect(contexts).toEqual([]);
    });

    it('renders the modal container and approval scripts with the approvalaction tokens', async () => {
      const { markup, contexts } = await render({ showApprovalStatus: false });
      expect(markup).toContain('<div style="display:none;" title="Status" id="approvalModalContainer"></div>');
      expect(markup).toContain(
        "var pars = 'muraAction=cArch.statusmodal&compactDisplay=true&siteid=' + siteid  + '&contenthistid=' + " +
          "contenthistid +'&cacheid=' + Math.random();",
      );
      expect(markup).toContain(
        "alertDialog('You\\x20must\\x20provide\\x20a\\x20comment\\x20when\\x20" +
          "rejecting\\x20an\\x20approval\\x20request');",
      );
      expect(markup).toContain(
        `csrf_token:'${APPROVAL_CSRF.token}',\n\t\t\t\t\tcsrf_token_expires: '${APPROVAL_CSRF.expires}'`,
      );
      expect(markup).toContain(`window.location.href.replace('${CONTENT_HIST_ID}',data.contenthistid);`);
      expect(markup).toMatch(/<\/script>\s*$/);
      expect(contexts).toEqual(['approvalaction']);
    });

    it.each<[boolean, string, string | undefined]>([
      [true, 'Pending', NOTICE.pending],
      [true, 'pending', NOTICE.pending],
      [true, 'Rejected', NOTICE.rejected],
      [true, 'REJECTED', NOTICE.rejected],
      [true, 'Approved', undefined],
      [true, 'Cancelled', undefined],
      [true, '', undefined],
      [false, 'Pending', undefined],
      [false, 'Rejected', undefined],
    ])('shown %s with status %j, notices %j', async (showApprovalStatus, approvalStatus, notice) => {
      const { markup } = await render({ showApprovalStatus, content: { ...CONTENT, approvalStatus } });
      const link =
        `<strong><a href="#" onclick="return viewStatusInfo('${HIST_ID_JS}','default');">View Details</a></strong>`;
      if (notice === undefined) {
        expect(markup).not.toContain('<div class="alert alert-error">');
        expect(markup).not.toContain(link);
      } else {
        expect(markup).toContain('<div class="alert alert-error">');
        expect(markup).toMatch(new RegExp(`${literal(notice)}\\s*${literal(link)}`));
      }
    });

    it('renders the lock notice before the approval status', async () => {
      const req = adminS2Request();
      const { markup, contexts } = await render(
        { hasLockableNodes: true, stats: nodeLock(req.session.mura.userID), showApprovalStatus: true },
        req,
      );
      expect(markup.indexOf('id="msg-node-locked"')).toBeLessThan(markup.indexOf('id="approvalModalContainer"'));
      expect(contexts).toEqual([`${CONTENT_ID}unlocknode`, 'approvalaction']);
    });
  });

  describe('calendar notices', () => {
    const CAL = 'http://localhost/calendar/_/date';
    const EDIT = '/admin/?muraAction=cArch.edit&siteid=default&contentid=';
    const CONFLICTS: readonly StatusConflict[] = [
      {
        editUrl: `${EDIT}E1`,
        title: 'Board & <Staff>',
        details: [
          { href: `${CAL}/2026/6/15/`, displayStart: '2026-06-15 10:00:00' },
          { href: `${CAL}/2026/10/29/`, displayStart: new Date(2026, 9, 29, 9) },
        ],
      },
      {
        editUrl: `${EDIT}E2`,
        title: 'Retreat',
        details: [{ href: `${CAL}/2026/6/16/`, displayStart: "{ts '2026-06-16 08:30:00'}" }],
      },
    ];

    it.each(['Calendar', 'calendar'])('notices the display window under a %s parent', async (parentType) => {
      const content = { display: 2, displayIntervalDesc: 'Daily, 9:00 AM - 10:00 AM' };
      const { markup } = await render({ ...calendarModel(content), parentType });
      expect(markup).toContain(
        '<div class="alert alert-info" >\n\t\t\t<span>\n\t\t\t\t<strong>Display:</strong> Daily, 9:00 AM - 10:00 AM',
      );
    });

    it.each<[string, Partial<StatusModel>]>([
      ['a non-scheduled display', calendarModel({ display: 1, conflicts: CONFLICTS.slice(1) })],
      ['a Folder parent', { ...calendarModel({ display: 2, conflicts: CONFLICTS }), parentType: 'Folder' }],
    ])('omits the display window under %s', async (_case, fields) => {
      const { markup } = await render(fields);
      expect(markup).not.toContain('alert-info');
    });

    it.each<[string, () => AdminRequest, string]>([
      ['true', () => adminS2Request({ rc: { compactDisplay: 'true' } }), 'target="_top"'],
      ['TRUE', () => adminS2Request({ rc: { compactDisplay: 'TRUE' } }), 'target="_top"'],
      ['yes', () => adminS2Request({ rc: { compactDisplay: 'yes' } }), 'target="_top"'],
      ['1', () => adminS2Request({ rc: { compactDisplay: '1' } }), 'target="_top"'],
      ['" TRUE"', () => adminS2Request({ rc: { compactDisplay: ' TRUE' } }), 'target="_top"'],
      ['" true"', () => adminS2Request({ rc: { compactDisplay: ' true' } }), 'target="_blank"'],
      ['"tr\\0ue"', () => adminS2Request({ rc: { compactDisplay: 'tr\u0000ue' } }), 'target="_top"'],
      ['"\\u0001yes"', () => adminS2Request({ rc: { compactDisplay: '\u0001yes' } }), 'target="_top"'],
      ['" 1.0 "', () => adminS2Request({ rc: { compactDisplay: ' 1.0 ' } }), 'target="_top"'],
      ['"2"', () => adminS2Request({ rc: { compactDisplay: '2' } }), 'target="_blank"'],
      ['false', () => adminS2Request({ rc: { compactDisplay: 'false' } }), 'target="_blank"'],
      ['the rc default', () => adminS2Request(), 'target="_blank"'],
      ['absent from rc', () => ({ ...adminS2Request(), rc: {} }), 'target="_blank"'],
    ])('links conflict dates for compactDisplay %s with %s', async (_case, request, target) => {
      const { markup } = await render(calendarModel({ conflicts: CONFLICTS }), request());
      expect(markup).toContain('<div class="alert alert-error">\n\t\t\t<span>\n\t\t\t<h3>Scheduling Conflicts:</h3>');
      expect(markup).toContain(`<p><strong><a href="${EDIT}E1">Board &amp; &lt;Staff&gt;:</strong></a>`);
      expect(markup).toMatch(
        new RegExp(
          literal(`<a href="${CAL}/2026/6/15/" ${target}>06/166/2026</a>`) +
            '\\s*, \\s*' +
            literal(`<a href="${CAL}/2026/10/29/" ${target}>10/302/2026</a>`) +
            '\\s*</p>',
        ),
      );
      expect(markup).toContain(`<p><strong><a href="${EDIT}E2">Retreat:</strong></a>`);
      expect(markup).toMatch(
        new RegExp(`${literal(`<a href="${CAL}/2026/6/16/" ${target}>06/167/2026</a>`)}\\s*</p>`),
      );
      expect(markup).not.toContain('alert-info');
    });

    it('links an empty date for an empty display start', async () => {
      const conflict: StatusConflict = {
        editUrl: `${EDIT}E2`,
        title: 'Retreat',
        details: [{ href: `${CAL}/2026/6/16/`, displayStart: '' }],
      };
      const { markup } = await render(calendarModel({ conflicts: [conflict] }));
      expect(markup).toMatch(new RegExp(`${literal(`<a href="${CAL}/2026/6/16/" target="_blank"></a>`)}\\s*</p>`));
    });

    it.each<[string, Partial<StatusModel>]>([
      ['a Calendar parent without conflicts', calendarModel({ conflicts: [] })],
      ['a non-Calendar parent', { ...calendarModel({ conflicts: CONFLICTS }), parentType: 'Page' }],
    ])('lists no conflicts under %s', async (_case, fields) => {
      const { markup } = await render(fields);
      expect(markup).not.toContain('Scheduling Conflicts');
      expect(markup).not.toContain('Board &amp;');
    });
  });
});
