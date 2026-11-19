/** `cfLocationHeader` and `sendsNodeRefusedLocationBytes` against the `Location` bytes ACF 2023 on Undertow answers for login redirects to the same URLs. */
import { validateHeaderValue } from 'node:http';
import { describe, expect, it } from 'vitest';
import { cfLocationHeader, sendsNodeRefusedLocationBytes } from '../../src/legacy-compat/index.js';

/** handleFailure's admin target with `contentid` and the URL-encoded `returnURL` interpolated (loginManager.cfc:240). */
const failed = (contentid: string, returnURL = ''): string =>
  `./?muraAction=cLogin.main&display=login&status=failed&rememberMe=0&contentid=${contentid}&LinkServID=&returnURL=${returnURL}&compactDisplay=false`;

/** Each C0 control but NUL, TAB, LF and CR after `/admin/a`, and the `%xx` legacy answers for it. */
const C0_ESCAPED = Array.from({ length: 0x1f }, (_, i) => i + 1)
  .filter((code) => code !== 0x09 && code !== 0x0a && code !== 0x0d)
  .map((code): [string, string, string] => {
    const hex = code.toString(16).padStart(2, '0');
    return [`U+00${hex.toUpperCase()}`, `/admin/a${String.fromCharCode(code)}X`, `/admin/a%${hex}X`];
  });

describe('cfLocationHeader', () => {
  it.each<[string, string, string]>([
    ['CR LF', '/admin/\r\nSet-Cookie: qasecc=1', '/admin/Set-Cookie: qasecc=1'],
    ['LF', '/admin/\nSet-Cookie: qasecc=1', '/admin/Set-Cookie: qasecc=1'],
    ['CR', '/admin/\rSet-Cookie: qasecc=1', '/admin/Set-Cookie: qasecc=1'],
    ['a leading CR LF', '\r\n/admin/x', '/admin/x'],
    ['CR LF before a second slash', '/\r\n/evil.example/x', '//evil.example/x'],
    ['NUL', '/admin/a\u0000X', '/admin/aX'],
    ['TAB', '/admin/a\tX', '/admin/a%09X'],
    ...C0_ESCAPED,
    ['a space', '/admin/a X', '/admin/a X'],
    ['lower-case %0d%0a', '/admin/%0d%0aSet-Cookie: qasecc=1', '/admin/Set-Cookie: qasecc=1'],
    ['upper-case %0D%0A', '/admin/%0D%0ASet-Cookie: qasecc=1', '/admin/Set-Cookie: qasecc=1'],
    ['%0d%0a before a second slash', '/%0d%0a/evil.example/x', '//evil.example/x'],
    ['%0d alone', '/admin/%0dX', '/admin/X'],
    ['%0a alone', '/admin/%0aX', '/admin/X'],
    ['%0a%0d', '/admin/%0a%0dX', '/admin/X'],
    ['mixed-case pairs', '/admin/%0D%0aX%0d%0AY', '/admin/XY'],
    ['%0D and %0A apart', '/admin/%0DX%0AY', '/admin/XY'],
    ['%0a removed first, joining a %0d', '/admin/%0%0adX', '/admin/X'],
    ['%0d removed second, joining a %0a', '/admin/%0%0daX', '/admin/%0aX'],
    ['one pass each over nested pairs', '/admin/%0%0d%0ad%0aX', '/admin/%0dX'],
    ['CR dropped before the %0d pass', '/admin/%0\rdX', '/admin/X'],
    ['NUL dropped before the %0d pass', '/admin/%0\u0000dX', '/admin/X'],
    ['TAB escaped before the %0d pass', '/admin/%0\tdX', '/admin/%0%09dX'],
    ['%00', '/admin/%00X', '/admin/%00X'],
    ['%09', '/admin/%09X', '/admin/%09X'],
    ['%250d', '/admin/%250dX', '/admin/%250dX'],
    ['escaped backslashes', '/admin/%5Cr%5CnX', '/admin/%5Cr%5CnX'],
    ['a space inside %0d', '/admin/%0 dX', '/admin/%0 dX'],
    ['spaces', '/admin/ a b', '/admin/ a b'],
    ['U+0080', '/admin/a\u0080X', '/admin/a\u0080X'],
    ['U+0085', '/admin/a\u0085X', '/admin/a\u0085X'],
    ['U+009F', '/admin/a\u009fX', '/admin/a\u009fX'],
    ['U+00A0', '/admin/a\u00a0X', '/admin/a\u00a0X'],
    ['U+00E9', '/admin/\u00e9X', '/admin/\u00e9X'],
    ['U+00FF', '/admin/a\u00ffX', '/admin/a\u00ffX'],
    ['U+2028 as its low byte', '/admin/\u2028Set-Cookie: qasecc=1', '/admin/(Set-Cookie: qasecc=1'],
    ['U+2029 as its low byte', '/admin/a\u2029X', '/admin/a)X'],
    ['U+FEFF as its low byte', '/admin/a\ufeffX', '/admin/a\u00ffX'],
    ['U+0109 as a TAB byte', '/admin/a\u0109X', '/admin/a\tX'],
    ['U+0120 as a space byte', '/admin/a\u0120X', '/admin/a X'],
    ['a trailing U+0120 as a trailing space', '/admin/x\u0120', '/admin/x '],
    ['U+010D, whose CR byte becomes a space', '/admin/\u010dX', '/admin/ X'],
    ['U+010A, whose LF byte becomes a space', '/admin/\u010aX', '/admin/ X'],
    ['U+0D0A, whose LF byte becomes a space', '/admin/a\u0d0aX', '/admin/a X'],
    ['U+0A0D, whose CR byte becomes a space', '/admin/a\u0a0dX', '/admin/a X'],
    ['a plain admin URL', './?muraAction=cArch.list', './?muraAction=cArch.list'],
    ["handleFailure's target with a URL-encoded CR LF", failed('', '%2Fadmin%2F%0D%0ASet%2DCookie%3A%20q%3D1'), failed('', '%2Fadmin%2FSet%2DCookie%3A%20q%3D1')],
    ["handleFailure's target with CR LF, %0d%0a and U+2028 in contentid", failed('ab\r\ncd%0d%0aef\u2028'), failed('abcdef(')],
    ["handleFailure's target with control characters in contentid", failed('ab\u0001cd\tefgh'), failed('ab%01cd%09efgh')],
  ])('answers the Location legacy answers for %s', (_label, url, location) => {
    const header = cfLocationHeader(url);

    expect(header).toBe(location);
    expect(() => validateHeaderValue('location', header)).not.toThrow();
    expect(() => new Headers({ location: header })).not.toThrow();
    expect(sendsNodeRefusedLocationBytes(url)).toBe(false);
  });

  it.each<[string, string, string, string]>([
    ['DEL', '/admin/a\u007fX', '/admin/a\u007fX', '/admin/a%7fX'],
    ['U+017F, whose low byte is DEL', '/admin/a\u017fX', '/admin/a\u007fX', '/admin/a%7fX'],
    ['U+0100, whose low byte is NUL', '/admin/a\u0100X', '/admin/a\u0000X', '/admin/a%00X'],
    ['an astral character, whose second surrogate has a NUL low byte', '/admin/\u{1f600}X', '/admin/=\u0000X', '/admin/=%00X'],
  ])('writes as %%xx a control byte legacy sends raw, which Node cannot send: %s', (_label, url, legacyBytes, location) => {
    const header = cfLocationHeader(url);

    expect(header).toBe(location);
    expect(() => validateHeaderValue('location', header)).not.toThrow();
    expect(() => validateHeaderValue('location', legacyBytes)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_CHAR' }));
    expect(sendsNodeRefusedLocationBytes(url)).toBe(true);
  });
});
