import { describe, expect, it } from 'vitest';
import {
  cfIsNumeric,
  cfListAppend,
  cfListQualifyChar,
  cfListToArray,
  legacyQuery,
  legacyUsersCsv,
} from '../../src/legacy-compat/index.js';

const USER_COLUMNS = ['userid', 'fname', 'password', 'inactive'];
const USERS = legacyQuery(USER_COLUMNS, [{ userid: 'ABC', fname: 'Smith, J', password: 'secret', inactive: '0' }]);
const USERS_HEADER_LINE = '"userid","fname","inactive"\n';

// Header and qa_editor row of GET /admin/?muraAction=cusers.download&siteid=default&ispublic=0 on Masa 7.6.1, ACF 2023.
const ORACLE_COLUMNS = [
  'ADMIN', 'EMAIL', 'FNAME', 'GROUPNAME', 'ISPUBLIC', 'LASTUPDATE', 'LASTUPDATEBY',
  'LNAME', 'S2', 'SITEID', 'SUBTYPE', 'TYPE', 'USERID', 'USERNAME',
];
const ORACLE_BODY =
  '"ADMIN","EMAIL","FNAME","GROUPNAME","ISPUBLIC","LASTUPDATE","LASTUPDATEBY","LNAME","S2","SITEID","SUBTYPE","TYPE","USERID","USERNAME"\n' +
  '" ","qa_editor@example.com ","QA "," ",0 ,"2026-11-10 09:07:57.137 ","Admin User ","Editor ",0 ,' +
  '"default ","Default ",2 ,"AF240756-C1CD-6298-60C0CAF70AACAE2B ","qa_editor "\n';

/** A cell as ListQualify CHAR emits it: bare when CFML reads it as numeric, quoted otherwise. */
function qualified(cell: string): string {
  return cfIsNumeric(cell) ? cell : `"${cell}"`;
}

describe('legacyUsersCsv body', () => {
  it('starts with the qualified column list minus password, ended by LF', () => {
    expect(legacyUsersCsv(USERS).body).toMatch(/^"userid","fname","inactive"\n/);
  });

  it('writes every column of a row, password included, each with a trailing space and its commas restored', () => {
    expect(legacyUsersCsv(USERS).body).toBe(`${USERS_HEADER_LINE}"ABC ","Smith, J ","secret ",${qualified('0 ')}\n`);
  });

  it('keeps every comma of a value inside one quoted cell', () => {
    const q = legacyQuery(['fname'], [{ fname: 'a,b,,c' }]);
    expect(legacyUsersCsv(q).body).toBe('"fname"\n"a,b,,c "\n');
  });

  it('ends every line with LF alone', () => {
    const { body } = legacyUsersCsv(USERS);
    expect(body).not.toContain('\r');
    expect(body.split('\n')).toHaveLength(3);
    expect(body.endsWith('\n')).toBe(true);
  });

  it('returns only the header line for a query without rows', () => {
    expect(legacyUsersCsv(legacyQuery(USER_COLUMNS, [])).body).toBe(USERS_HEADER_LINE);
  });

  it.each(['PASSWORD', 'Password'])('drops the %s column from the header case-insensitively but keeps it in rows', (column) => {
    const q = legacyQuery(['userid', column], [{ userid: 'ABC', [column]: 'secret' }]);
    expect(legacyUsersCsv(q).body).toBe('"userid"\n"ABC ","secret "\n');
  });

  it('reproduces the ACF 2023 cusers.download body, resolving columns case-insensitively and NULL as empty', () => {
    const q = legacyQuery(ORACLE_COLUMNS, [
      {
        admin: null,
        email: 'qa_editor@example.com',
        fname: 'QA',
        groupname: '',
        ispublic: 0,
        lastupdate: '2026-11-10 09:07:57.137',
        lastupdateby: 'Admin User',
        lname: 'Editor',
        s2: 0,
        siteid: 'default',
        subtype: 'Default',
        type: 2,
        userid: 'AF240756-C1CD-6298-60C0CAF70AACAE2B',
        username: 'qa_editor',
      },
    ]);
    expect(legacyUsersCsv(q).body).toBe(ORACLE_BODY);
  });
});

describe('legacyUsersCsv headers', () => {
  it('sends users.csv as an attachment with the content type ACF gives cfcontent type="text/csv"', () => {
    // ACF 2023 appends the charset (observed on cusers.download), so the bare text/csv of dsp_download.cfm never reaches the wire.
    expect(legacyUsersCsv(USERS).headers).toEqual({
      'Content-Disposition': 'attachment;filename=users.csv',
      'Content-Type': 'text/csv; charset=UTF-8',
    });
  });
});

describe('CFML list primitives', () => {
  it.each([
    { list: 'a,1,b', expected: '"a",1,"b"' },
    { list: 'a,,b', expected: '"a","b"' },
    { list: 'say "hi",2 ', expected: '"say "hi"",2 ' },
  ])('cfListQualifyChar turns $list into $expected', ({ list, expected }) => {
    expect(cfListQualifyChar(list)).toBe(expected);
  });

  it.each([
    { list: '', value: 'x', expected: 'x' },
    { list: 'x', value: 'y', expected: 'x,y' },
  ])('cfListAppend($list, $value) returns $expected', ({ list, value, expected }) => {
    expect(cfListAppend(list, value)).toBe(expected);
  });

  it('cfListToArray drops empty items', () => {
    expect(cfListToArray('a,,b,')).toEqual(['a', 'b']);
  });
});
