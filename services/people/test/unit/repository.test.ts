/** People repository rules that need no database: the lastUpdateInfo label and the legacyStorable width and range checks. */
import { describe, expect, it } from 'vitest';
import { RepositoryError, type RepositoryRow } from '@opt2/platform/migration-kit';
import { LegacyStorageError, OWNER, SCHEMA, lastUpdateInfo, legacyStorable, type AuditActor, type LegacyLimitedTable } from '../../src/repo/repository.js';

describe('lastUpdateInfo', () => {
  const person = { userid: 'PERSON', fname: 'Pat', lname: 'Lee' };
  const actor: AuditActor = { userId: 'ACTOR', fname: 'Ada', lname: 'Admin', isLoggedIn: true };

  it.each([
    ['a logged-in actor names itself', actor, person, { lastupdateby: 'Ada Admin', lastupdatebyid: 'ACTOR' }],
    ['no actor names the person', null, person, { lastupdateby: 'Pat Lee', lastupdatebyid: 'PERSON' }],
    ['a logged-out actor names the person', { ...actor, isLoggedIn: false }, person, { lastupdateby: 'Pat Lee', lastupdatebyid: 'PERSON' }],
    ['missing names give the empty label', undefined, { userid: 'P' }, { lastupdateby: '', lastupdatebyid: 'P' }],
    ['a missing surname leaves no trailing space', null, { userid: 'P', fname: 'Alice', lname: null }, { lastupdateby: 'Alice', lastupdatebyid: 'P' }],
    ['a missing first name leaves no leading space', null, { userid: 'P', lname: 'Lee' }, { lastupdateby: 'Lee', lastupdatebyid: 'P' }],
    ['outer whitespace and control characters are trimmed', { ...actor, fname: '\t Ada', lname: 'Admin \n' }, person, {
      lastupdateby: 'Ada Admin',
      lastupdatebyid: 'ACTOR',
    }],
    ['the label is cut at 50 characters', { ...actor, fname: 'x'.repeat(40), lname: 'y'.repeat(20) }, person, {
      lastupdateby: `${'x'.repeat(40)} ${'y'.repeat(9)}`,
      lastupdatebyid: 'ACTOR',
    }],
    ['a space at character 50 is trimmed after the cut', null, { userid: 'P', fname: 'x'.repeat(49), lname: 'y' }, {
      lastupdateby: 'x'.repeat(49),
      lastupdatebyid: 'P',
    }],
    ['leading spaces are trimmed after the cut', null, { userid: 'P', fname: `  ${'x'.repeat(47)}`, lname: 'yz' }, {
      lastupdateby: 'x'.repeat(47),
      lastupdatebyid: 'P',
    }],
  ] as const)('%s', (_label, who, subject, expected) => {
    expect(lastUpdateInfo(who, subject)).toEqual(expected);
  });

  it('names the service and schema', () => {
    expect([OWNER, SCHEMA]).toEqual(['people', 'people']);
  });
});

describe('legacyStorable', () => {
  const smile = '\u{1F600}';

  it.each<[string, LegacyLimitedTable, RepositoryRow, RepositoryRow]>([
    ['a value at the width', 'user_tag', { tag: 'x'.repeat(100), siteid: 's'.repeat(25) }, { tag: 'x'.repeat(100), siteid: 's'.repeat(25) }],
    ['only trailing spaces beyond the width, cut', 'person', { fname: `${'x'.repeat(50)}   `, notes: ' n ' }, { fname: 'x'.repeat(50), notes: ' n ' }],
    ['NULL, absent and unlimited columns', 'person', { fname: null, tags: 'x'.repeat(300) }, { fname: null, tags: 'x'.repeat(300) }],
    ['surrogate pairs within the width', 'person', { fname: smile.repeat(25) }, { fname: smile.repeat(25) }],
    ['the tinyint bounds', 'user_address', { isprimary: 0 }, { isprimary: 0 }],
    ['the tinyint top', 'person', { keepprivate: 255 }, { keepprivate: 255 }],
    ['a finite float', 'extend_data_user_activity', { numericvalue: -1.5e300 }, { numericvalue: -1.5e300 }],
    ['the last 1752 time, which rounds into 1753', 'trash', { deleteddate: new Date(1752, 11, 31, 23, 59, 59, 999) }, { deleteddate: new Date(1752, 11, 31, 23, 59, 59, 999) }],
    ['the datetime floor', 'extend_data_user_activity', { datetimevalue: new Date(1753, 0, 1, 0, 0, 0, 0) }, { datetimevalue: new Date(1753, 0, 1, 0, 0, 0, 0) }],
    ['the last datetime', 'extend_data_user_activity', { datetimevalue: new Date(9999, 11, 31, 23, 59, 59, 998) }, { datetimevalue: new Date(9999, 11, 31, 23, 59, 59, 998) }],
    ['datetime text', 'trash', { deleteddate: '2026-06-30 10:00:00' }, { deleteddate: '2026-06-30 10:00:00' }],
  ])('stores %s', (_label, table, row, expected) => {
    expect(legacyStorable(table, row)).toEqual(expected);
  });

  it.each<[string, LegacyLimitedTable, RepositoryRow, string, 'width' | 'range']>([
    ['text beyond the width', 'user_tag', { tag: 'x'.repeat(101) }, 'tag', 'width'],
    ['a space then text beyond the width', 'person', { fname: `${'x'.repeat(50)} y` }, 'fname', 'width'],
    ['surrogate pairs beyond the width', 'person', { fname: smile.repeat(26) }, 'fname', 'width'],
    ['a varchar(25) site id of 26', 'trash', { siteid: 's'.repeat(26) }, 'siteid', 'width'],
    ['a tinyint below 0', 'person', { keepprivate: -1 }, 'keepprivate', 'range'],
    ['a tinyint above 255', 'user_address', { isprimary: 256 }, 'isprimary', 'range'],
    ['a NaN float', 'user_address', { longitude: Number.NaN }, 'longitude', 'range'],
    ['an infinite float', 'extend_data_user_activity', { numericvalue: Number.NEGATIVE_INFINITY }, 'numericvalue', 'range'],
    ['a datetime that rounds below 1753', 'trash', { deleteddate: new Date(1752, 11, 31, 23, 59, 59, 998) }, 'deleteddate', 'range'],
    ['a datetime that rounds past 9999', 'extend_data_user_activity', { datetimevalue: new Date(9999, 11, 31, 23, 59, 59, 999) }, 'datetimevalue', 'range'],
    ['an invalid Date', 'extend_data_user_activity', { datetimevalue: new Date(Number.NaN) }, 'datetimevalue', 'range'],
    ['datetime text that does not parse', 'trash', { deleteddate: 'not a date' }, 'deleteddate', 'range'],
  ])('rejects %s', (_label, table, row, column, violation) => {
    let thrown: unknown;
    try {
      legacyStorable(table, row);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LegacyStorageError);
    expect(thrown).toBeInstanceOf(RepositoryError);
    expect(thrown).toMatchObject({ table, column, violation });
  });
});
