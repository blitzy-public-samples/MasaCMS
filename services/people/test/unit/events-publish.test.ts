/** People's topics and payload builders: topic names and validators, producer schemas, and person and archive payloads. */
import { describe, expect, it } from 'vitest';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { TENANT_A } from '@opt2/platform/testing';
import { personArchivedPayload, personChangedPayload } from '../../src/events/publish.js';
import {
  GROUP_CHANGED_TOPIC,
  PEOPLE_TOPICS,
  PERSON_ARCHIVED_TOPIC,
  PERSON_CHANGED_TOPIC,
  SITE_CHANGED_TOPIC,
  groupChangedSchema,
  peoplePayloadValidators,
  personArchivedSchema,
  personChangedSchema,
  siteChangedSchema,
} from '../../src/events/topics.js';
import type { PersonArchiveRow, PersonRow } from '../../src/repo/tables.js';
import { NOW, NOW_TEXT, personRow } from '../helpers/publish-rows.js';

/** Whether `payload` satisfies the compiled contract of `topic`. */
function conforms(topic: string, payload: unknown): boolean | undefined {
  return peoplePayloadValidators[topic]?.validatePayload(payload).ok;
}

describe('people topics', () => {
  it('names the produced topics and compiles their contracts with their declared kinds', () => {
    expect(PEOPLE_TOPICS).toStrictEqual([PERSON_CHANGED_TOPIC, PERSON_ARCHIVED_TOPIC]);
    expect([PERSON_CHANGED_TOPIC, PERSON_ARCHIVED_TOPIC, GROUP_CHANGED_TOPIC, SITE_CHANGED_TOPIC]).toStrictEqual([
      'people.person.changed.v1',
      'people.person.archived.v1',
      'identity.group.changed.v1',
      'programs-sites.site.changed.v1',
    ]);
    expect(Object.keys(peoplePayloadValidators)).toStrictEqual([...PEOPLE_TOPICS]);
    expect(PEOPLE_TOPICS.map((topic) => peoplePayloadValidators[topic]?.meta)).toStrictEqual([
      { kind: 'state' },
      { kind: 'process', fanout: 'userPool' },
    ]);
    expect(Object.isFrozen(peoplePayloadValidators)).toBe(true);
  });

  it.each([
    ['people person changed', personChangedSchema, 'urn:opt2:people:event:people.person.changed.v1'],
    ['people person archived', personArchivedSchema, 'urn:opt2:people:event:people.person.archived.v1'],
    ['identity group changed', groupChangedSchema, 'urn:opt2:identity:event:identity.group.changed.v1'],
    ['programs-sites site changed', siteChangedSchema, 'urn:opt2:programs-sites:event:programs-sites.site.changed.v1'],
  ])('reads the %s schema from its producer contracts', (_label, schema, id) => {
    expect(schema.$id).toBe(id);
    expect(schema.$comment).toBe('source-sha: 696383140578f8dea3ece26f80cd7bfb370ddf0f');
  });
});

describe('person payloads', () => {
  it('carries every people-owned column of the stored row under its contract name, timestamps as local text', () => {
    const row = personRow({ ext: 12, notes: 'n', tags: 'red,blue', lastupdate: new Date(2026, 5, 30, 11, 15, 30, 250) });

    const payload = personChangedPayload(row, { deleted: false });

    expect(Object.keys(payload)).toStrictEqual(personChangedSchema.required);
    expect(payload).toMatchObject({ userId: row.userid, siteId: TENANT_A.siteId, deleted: false, ext: 12, notes: 'n', tags: 'red,blue' });
    expect([payload.created, payload.lastUpdate]).toStrictEqual([NOW_TEXT, '2026-06-30 11:15:30.250']);
    expect(conforms(PERSON_CHANGED_TOPIC, payload)).toBe(true);
  });

  it.each<[string, Record<'created' | 'lastupdate', string | null>, Record<'created' | 'lastUpdate', string | null>]>([
    ['timestamp text as stored', { created: '2020-01-02 03:04:05.006', lastupdate: '2021-01-02 03:04:05.000' }, { created: '2020-01-02 03:04:05.006', lastUpdate: '2021-01-02 03:04:05.000' }],
    ['null timestamps as null', { created: null, lastupdate: null }, { created: null, lastUpdate: null }],
  ])('keeps %s', (_label, times, expected) => {
    const row = { ...personRow(), ...times } as unknown as PersonRow;

    const payload = personChangedPayload(row, { deleted: true });

    expect(payload).toMatchObject({ ...expected, deleted: true });
    expect(conforms(PERSON_CHANGED_TOPIC, payload)).toBe(true);
  });

  it('leaves a person without a site id to the payload contract', () => {
    const payload = personChangedPayload(personRow({ siteid: null }), { deleted: false });

    expect(payload.siteId).toBe('');
    expect(conforms(PERSON_CHANGED_TOPIC, payload)).toBe(false);
  });

  it.each<[string, Record<'effective_from' | 'archived_at', Date | string>, string, string]>([
    ['Date values', { effective_from: new Date(2026, 6, 1, 0, 0, 0, 0), archived_at: NOW }, '2026-07-01 00:00:00.000', NOW_TEXT],
    ['text values', { effective_from: '2026-07-01 00:00:00.000', archived_at: '2026-06-30 09:59:59.999' }, '2026-07-01 00:00:00.000', '2026-06-30 09:59:59.999'],
  ])('builds an archive payload from %s', (_label, times, effectiveFrom, archivedAt) => {
    const archive = { tenant_id: TENANT_A.tenantId, archive_id: cfUuid(), person_id: cfUuid(), siteid: TENANT_A.siteId, archived_by_id: null, archived_by: null, ...times };

    const payload = personArchivedPayload(archive as unknown as PersonArchiveRow);

    expect(payload).toStrictEqual({ personId: archive.person_id, siteId: TENANT_A.siteId, effectiveFrom, archiveId: archive.archive_id, archivedAt });
    expect(conforms(PERSON_ARCHIVED_TOPIC, payload)).toBe(true);
  });
});
