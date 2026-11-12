// cMessage.noaccess against admin/core/views/cmessage/noaccess.cfm: the contact link mails configBean getAdminEmail().
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLegacySettingsForTests } from '@/lib/env';
import { toString } from '@/lib/html';
import { renderNoaccess } from '@/screens/cmessage/noaccess';
import { useTestEnv } from '../../helpers/env';

let restoreEnv: () => void;

beforeEach(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith('MURA_')) vi.stubEnv(key, undefined);
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

describe('renderNoaccess', () => {
  it.each<[string | undefined, string]>([
    [undefined, 'mailto:'],
    ['ops@example.test', 'mailto:ops%40example.test'],
    // A CFML expression resolves to '', as for every MURA_* setting.
    ['${application.adminEmail}', 'mailto:'],
  ])('links MURA_ADMINEMAIL=%j as href %j', (adminEmail, href) => {
    vi.stubEnv('MURA_ADMINEMAIL', adminEmail);
    resetLegacySettingsForTests();
    expect(toString(renderNoaccess().body)).toContain(`<a href="${href}">administrator</a>`);
  });
});
