/** legacyApiSettings, the JSON API routes' reading of the MURA variables. */
import { describe, expect, it } from 'vitest';
import { legacyApiSettings } from '../../src/routes/legacy-api.js';

describe('legacyApiSettings', () => {
  it('reads the MURA variables and defaults the rest', () => {
    expect(legacyApiSettings({})).toEqual({ adminSSL: false, context: '', appReloadKey: 'appreload', adminDomain: '' });
    expect(
      legacyApiSettings({ MURA_ADMINSSL: 'true', MURA_PORT: '8080', MURA_CONTEXT: '/masa/', MURA_APPRELOADKEY: 'reload', MURA_ADMINDOMAIN: 'admin.example' }),
    ).toEqual({ adminSSL: true, serverPort: ':8080', context: '/masa', appReloadKey: 'reload', adminDomain: 'admin.example' });
    expect(legacyApiSettings({ MURA_PORT: '443', MURA_CONTEXT: '${context}' })).toMatchObject({ serverPort: '', context: '' });
  });

  it('names each malformed variable', () => {
    expect(() => legacyApiSettings({ MURA_ADMINSSL: 'maybe', MURA_PORT: '99999' })).toThrow(/MURA_ADMINSSL[\s\S]*MURA_PORT|MURA_PORT[\s\S]*MURA_ADMINSSL/);
  });
});
