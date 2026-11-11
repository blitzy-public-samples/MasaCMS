// Unit tests for the stored file-name and content-files object-key helpers.
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { describe, expect, it } from 'vitest';

import {
  InvalidStoredNameError,
  formatStoredName,
  objectKey,
  parseObjectKey,
  parseStoredName,
  type StoredName,
} from '../../src/files/names.js';

const FILE_ID = 'C3700000-0000-0000-0000000000000F07';
const TENANT = tenantIdForSite('default');

describe('stored names', () => {
  it.each<[string, StoredName]>([
    [`${FILE_ID}.pdf`, { fileId: FILE_ID, variant: '', ext: 'pdf' }],
    [`${FILE_ID}_source.png`, { fileId: FILE_ID, variant: '_source', ext: 'png' }],
    [`${FILE_ID}.flv`, { fileId: FILE_ID, variant: '', ext: 'flv' }],
    [`${FILE_ID}_small.jpg`, { fileId: FILE_ID, variant: '_small', ext: 'jpg' }],
    [`${FILE_ID}_medium.JPG`, { fileId: FILE_ID, variant: '_medium', ext: 'JPG' }],
    [`${FILE_ID}_W100_H50.jpg`, { fileId: FILE_ID, variant: '_W100_H50', ext: 'jpg' }],
    [`${FILE_ID}_W200.5_HAUTO.gif`, { fileId: FILE_ID, variant: '_W200.5_HAUTO', ext: 'gif' }],
    [`${FILE_ID}_hero-wide.jpeg`, { fileId: FILE_ID, variant: '_hero-wide', ext: 'jpeg' }],
    [`${FILE_ID}_größe.png`, { fileId: FILE_ID, variant: '_größe', ext: 'png' }],
  ])('round-trips %j through parse, format, objectKey and parseObjectKey', (name, parts) => {
    expect(parseStoredName(name)).toEqual(parts);
    expect(formatStoredName(parts)).toBe(name);
    const key = objectKey(TENANT, parts.fileId, parts.variant, parts.ext);
    expect(key).toBe(`${TENANT}/${name}`);
    expect(parseObjectKey(key)).toEqual({ tenantId: TENANT, ...parts });
  });

  it.each([
    '../x',
    'a/b',
    `${FILE_ID}_a/b.jpg`,
    `${FILE_ID}_a\\b.jpg`,
    `${FILE_ID.slice(1)}.jpg`,
    `${FILE_ID}_small`,
    `${FILE_ID}_a\u0000b.jpg`,
    `${FILE_ID}_a\u001fb.jpg`,
    `${FILE_ID}_a\u007fb.jpg`,
    `${FILE_ID}_.jpg`,
  ])('rejects %j as a stored name', (name) => {
    expect(parseStoredName(name)).toBeNull();
    expect(parseObjectKey(`${TENANT}/${name}`)).toBeNull();
  });

  it.each<[string, StoredName]>([
    ['a dotted extension that would parse as part of the variant', { fileId: FILE_ID, variant: '_a', ext: 'b.jpg' }],
    ['a separator in the variant', { fileId: FILE_ID, variant: '_a/b', ext: 'jpg' }],
    ['an empty variant after the underscore', { fileId: FILE_ID, variant: '_', ext: 'jpg' }],
    ['a fileId that carries a variant', { fileId: `${FILE_ID}_x`, variant: '', ext: 'jpg' }],
    ['a 36-character fileId', { fileId: `${FILE_ID}0`, variant: '', ext: 'jpg' }],
  ])('refuses to format %s', (_case, parts) => {
    expect(() => formatStoredName(parts)).toThrow(InvalidStoredNameError);
    expect(() => objectKey(TENANT, parts.fileId, parts.variant, parts.ext)).toThrow(InvalidStoredNameError);
  });
});
