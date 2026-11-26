// The `cUsers.downloadGroupMembers` action: FW/1 hands a group's members CSV source to `cUsers.download` (server-only).
import type { RedirectScreen, ScreenContext, SubmitResult } from '../registry';
import { cusersGate, normaliseCusersRc } from './gate';
import type { UsersCsvSource } from './inc/dsp_download';

/** Sets `rc.records` to the members source, then `fw.redirect(action='cUsers.download', preserve='records')`. */
async function submitDownloadGroupMembers({ req }: ScreenContext): Promise<SubmitResult> {
  // The flash context carries the source as JSON, never rows: `cUsers.download` reads the members from identity.
  const records: UsersCsvSource = { source: 'group-members', groupId: normaliseCusersRc(req).userid };
  return { kind: 'redirect', action: 'cUsers.download', preserve: 'records', rc: { records: JSON.stringify(records) } };
}

/** `cUsers.downloadGroupMembers`, linked by GET from the group's members screen, behind the cUsers `before()` gate. */
export const downloadGroupMembersAction: RedirectScreen = Object.freeze({
  circuit: 'cusers',
  action: 'downloadgroupmembers',
  mode: 'redirect',
  owner: 'identity',
  gate: cusersGate,
  submit: submitDownloadGroupMembers,
});
