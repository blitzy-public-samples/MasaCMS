/** Masa's text storage: every string parameter it binds as `cf_sql_varchar`, which SQL Server converts to code page 1252. */

/** The 27 characters Windows-1252 places at 0x80-0x9F. */
const CP1252_HIGH: ReadonlySet<string> = new Set(
  '\u20ac\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u017d\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u017e\u0178',
);

/** `text` as legacy stores or compares it: each UTF-16 code unit outside Windows-1252 as `?`, so an astral character becomes `??`. */
export function windows1252Text(text: string): string {
  let stored = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const unit = text.charAt(i);
    stored += code < 0x80 || (code >= 0xa0 && code <= 0xff) || CP1252_HIGH.has(unit) ? unit : '?';
  }
  return stored;
}
