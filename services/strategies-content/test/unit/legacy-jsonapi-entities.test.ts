// JSON API entity registrations of strategies-content against jsonApiUtility.cfc and the content beans.
import { existsSync, readFileSync } from 'node:fs';
import { createApiSerializer, REGISTERED_ENTITIES } from '@opt2/platform/legacy-compat';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  CONTENT_ENTITIES,
  type ContentEntityName,
  contentEntities,
  entityModuleRole,
  entitySerializerHints,
  getContentEntityConfig,
  isContentEntity,
} from '../../src/legacy/jsonapi-entities.js';

const API_UTILITY = new URL('../../../../core/mura/client/api/json/v1/jsonApiUtility.cfc', import.meta.url);
const CONTRACT = new URL('../../contracts/openapi.yaml', import.meta.url);
const sourceLines = readFileSync(API_UTILITY, 'utf8').split('\n');

/** The `fields="…"` value on a 1-based line of jsonApiUtility.cfc. */
function legacyFields(line: number): string {
  const match = /fields="([^"]*)"/.exec(sourceLines[line - 1] ?? '');
  if (match?.[1] === undefined) throw new Error(`no field list on jsonApiUtility.cfc:${String(line)}`);
  return match[1];
}

/** `{ public, moduleid }` of each `registerEntity('<name>',{…})` call in init. */
function legacyRegistrations(): Map<string, { public: boolean; moduleid: string }> {
  const text = sourceLines.slice(0, 110).join('\n');
  const registrations = new Map<string, { public: boolean; moduleid: string }>();
  for (const [, name = '', body = ''] of text.matchAll(/^\s*registerEntity\('(\w+)',\{([^}]*)\}/gm)) {
    registrations.set(name, {
      public: body.includes('public=true'),
      moduleid: /moduleid='(\d{35})'/.exec(body)?.[1] ?? '00000000000000000000000000000000000',
    });
  }
  return registrations;
}

describe('CONTENT_ENTITIES', () => {
  it.each<[ContentEntityName, number]>([
    ['contentnav', 39],
    ['content', 77],
    ['comment', 83],
  ])('%s keeps the field list of jsonApiUtility.cfc:%i byte for byte', (name, line) => {
    expect(CONTENT_ENTITIES[name].fields?.join(',')).toBe(legacyFields(line));
  });

  it.each<ContentEntityName>([
    'changeset',
    'feed',
    'category',
    'contentCategoryAssign',
    'file',
    'fileMetaData',
    'changesetCategoryAssignment',
    'stats',
    'variationTargeting',
  ])('%s has no field list', (name) => {
    expect(CONTENT_ENTITIES[name]).not.toHaveProperty('fields');
  });

  it('matches public and moduleid of every registerEntity call for a content entity', () => {
    const registrations = legacyRegistrations();
    const owned = [...registrations.keys()].filter(isContentEntity);
    expect(owned).toEqual([
      'content',
      'comment',
      'changeset',
      'feed',
      'category',
      'contentCategoryAssign',
      'file',
      'fileMetaData',
      'changesetCategoryAssignment',
      'stats',
      'variationTargeting',
    ]);
    for (const name of owned) {
      const config = CONTENT_ENTITIES[name as ContentEntityName];
      expect({ public: config.public, moduleid: config.moduleId }, name).toEqual(registrations.get(name));
    }
    expect(CONTENT_ENTITIES.contentnav).toMatchObject({ public: true, moduleId: '00000000000000000000000000000000000' });
  });

  it.each<[ContentEntityName, string, string, `m:${string}`]>([
    ['contentnav', 'contentid', 'content', 'm:000'],
    ['content', 'contentid', 'content', 'm:000'],
    ['comment', 'commentid', 'comment', 'm:015'],
    ['changeset', 'changesetid', 'changeset', 'm:014'],
    ['feed', 'feedid', 'content', 'm:011'],
    ['category', 'categoryid', 'category', 'm:010'],
    ['contentCategoryAssign', '', 'contentCategoryAssign', 'm:000'],
    ['file', 'fileid', 'file', 'm:000'],
    ['fileMetaData', 'metaid', 'fileMetaData', 'm:000'],
    ['changesetCategoryAssignment', 'assignmentid', 'changesetCategoryAssignment', 'm:000'],
    ['stats', 'contentid', 'stats', 'm:000'],
    ['variationTargeting', 'targetingid', 'variationTargeting', 'm:000'],
  ])('%s: primary key %j, display name %j, role %s', (name, primaryKey, displayName, role) => {
    const config = CONTENT_ENTITIES[name];
    expect(config).toMatchObject({ name, primaryKey, displayName, allowFieldSelect: true });
    expect(config.moduleId).toHaveLength(35);
    expect(entityModuleRole(name)).toBe(role);
  });

  it.each<[ContentEntityName, string, string]>([
    ['content', 'displayStart', 'date'],
    ['content', 'active', 'float'],
    ['comment', 'entered', 'date'],
    ['feed', 'pageIndex', 'float'],
    ['file', 'fileSize', 'integer'],
    ['fileMetaData', 'filesize', 'integer'],
    ['contentCategoryAssign', 'isfeature', 'integer'],
    ['contentCategoryAssign', 'featureSop', 'date'],
    ['stats', 'comments', 'float'],
    ['changesetCategoryAssignment', 'isNew', 'float'],
  ])('%s hints %s as %s', (name, property, hint) => {
    expect(CONTENT_ENTITIES[name].hints[property]).toBe(hint);
  });

  it('hints no string, boolean or relation property', () => {
    expect(CONTENT_ENTITIES.content.hints).not.toHaveProperty('title');
    expect(CONTENT_ENTITIES.content.hints).not.toHaveProperty('approvalChainOverride');
    expect(CONTENT_ENTITIES.content.hints).not.toHaveProperty('fileSize');
    expect(CONTENT_ENTITIES.contentCategoryAssign.hints).not.toHaveProperty('featureStop');
    expect(CONTENT_ENTITIES.variationTargeting.hints).toEqual({ isNew: 'float' });
  });

  it('records relations as getProperties builds them, including the fileMetaData back-reference on file', () => {
    expect(CONTENT_ENTITIES.file.hasMany).toEqual([
      { name: 'fileMetaData', cfc: 'fileMetaData', loadkey: 'fileid', column: 'fileid' },
    ]);
    expect(CONTENT_ENTITIES.comment.hasMany).toEqual([
      { name: 'kids', cfc: 'comment', loadkey: 'parentid', column: 'primaryKey' },
    ]);
    expect(CONTENT_ENTITIES.contentnav.hasMany).toEqual(CONTENT_ENTITIES.content.hasMany);
    expect(CONTENT_ENTITIES.contentnav.hasOne).toEqual(CONTENT_ENTITIES.content.hasOne);
    expect(CONTENT_ENTITIES.content.hasOne.map((p) => p.name)).toEqual(['parent', 'site', 'changeset', 'stats']);
    expect(CONTENT_ENTITIES.changeset.hasOne).toEqual([]);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(CONTENT_ENTITIES)).toBe(true);
    expect(Object.isFrozen(CONTENT_ENTITIES.content.fields)).toBe(true);
    expect(Object.isFrozen(CONTENT_ENTITIES.content.hints)).toBe(true);
    expect(Object.isFrozen(CONTENT_ENTITIES.content.hasMany[0])).toBe(true);
  });
});

describe('contentEntities', () => {
  const registered = REGISTERED_ENTITIES.filter(isContentEntity);

  it.each([
    [false, ['contentnav', ...registered]],
    [true, ['contentnav', ...registered, 'variationTargeting']],
  ])('variations=%s lists the registrations in legacy order', (variations, names) => {
    expect(contentEntities({ variations }).map((e) => e.name)).toEqual(names);
  });

  it('covers every entity of the table', () => {
    expect(registered).toHaveLength(10);
    expect(contentEntities({ variations: true }).map((e) => e.name).sort()).toEqual(
      Object.keys(CONTENT_ENTITIES).sort(),
    );
  });
});

describe('getContentEntityConfig and isContentEntity', () => {
  it.each<[string, ContentEntityName]>([
    ['content', 'content'],
    ['CONTENTNAV', 'contentnav'],
    ['contentcategoryassign', 'contentCategoryAssign'],
    ['FileMetaData', 'fileMetaData'],
    ['variationtargeting', 'variationTargeting'],
  ])('finds %s case-insensitively as %s', (name, entity) => {
    expect(getContentEntityConfig(name)).toBe(CONTENT_ENTITIES[entity]);
    expect(isContentEntity(name)).toBe(true);
  });

  it.each(['site', 'user', 'group', 'address', 'entity', 'swagger', ''])('answers %j as unregistered', (name) => {
    expect(getContentEntityConfig(name)).toEqual({ public: false });
    expect(isContentEntity(name)).toBe(false);
  });
});

describe('entitySerializerHints', () => {
  const hints = entitySerializerHints('contentCategoryAssign');

  it('is the same shared list for every content entity and empty for other names', () => {
    for (const name of Object.keys(CONTENT_ENTITIES)) expect(entitySerializerHints(name)).toBe(hints);
    expect(entitySerializerHints('site')).toEqual([]);
  });

  it('keeps the first registration of a key, case-insensitively', () => {
    const keys = hints.map((h) => h.key.toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
    expect(hints.find((h) => h.key.toLowerCase() === 'isfeature')).toEqual({ key: 'isFeature', hint: 'float' });
    expect(hints.find((h) => h.key === 'deleted')).toEqual({ key: 'deleted', hint: 'integer' });
    expect(hints[0]).toEqual({ key: 'active', hint: 'float' });
  });

  it('serializes keys hinted by another content entity as the shared legacy serializer does', () => {
    const body = createApiSerializer(hints).serialize({
      featureStop: new Date(2026, 5, 30, 8, 15, 0),
      orderno: '3',
      comments: '42',
      title: '7',
    });
    expect(body).toBe('{"featurestop":"2026-06-30T08:15:00","orderno":3,"comments":42,"title":"7"}');
  });
});

describe.skipIf(!existsSync(CONTRACT))('contracts/openapi.yaml', () => {
  it('names only registered content entities in x-opt2-entity-access', () => {
    const contract = parse(readFileSync(CONTRACT, 'utf8')) as Record<string, unknown>;
    const access = contract['x-opt2-entity-access'] as Record<string, unknown> | undefined;
    expect(access).toBeDefined();
    for (const name of Object.keys(access ?? {})) expect(isContentEntity(name), name).toBe(true);
  });
});
