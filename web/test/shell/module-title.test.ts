// Unit tests for the admin module title switch and `<title>` markup.
import { describe, expect, it } from 'vitest';
import { isSafeHtml, toString } from '@/lib/html';
import {
  CONTENT_MODULE_IDS,
  compactTitleElement,
  resolveModuleTitle,
  templateTitleElement,
  templateTitleText,
  type ModuleTitleInput,
} from '@/shell/module-title';

const OTHER_MODULE_ID = '00000000000000000000000000000000008';

const input = (overrides: Partial<ModuleTitleInput> = {}): ModuleTitleInput => ({
  originalCircuit: 'csettings',
  originalFuseaction: 'list',
  moduleId: '',
  action: 'core:csettings.list',
  bodyclass: 'foo',
  ...overrides,
});

const carch = (overrides: Partial<ModuleTitleInput> = {}): ModuleTitleInput =>
  input({ originalCircuit: 'carch', moduleId: OTHER_MODULE_ID, action: 'core:carch.list', ...overrides });

describe('CONTENT_MODULE_IDS', () => {
  it('is frozen and holds the four content ids in order', () => {
    expect(Object.isFrozen(CONTENT_MODULE_IDS)).toBe(true);
    expect(CONTENT_MODULE_IDS).toEqual([
      '00000000000000000000000000000000000',
      '00000000000000000000000000000000003',
      '00000000000000000000000000000000004',
      '00000000000000000000000000000000099',
    ]);
  });
});

describe('resolveModuleTitle', () => {
  it('returns a non-empty override with bodyclass untouched', () => {
    expect(resolveModuleTitle(carch({ override: 'Custom', moduleId: CONTENT_MODULE_IDS[0] }))).toEqual({
      moduleTitle: 'Custom',
      bodyclass: 'foo',
    });
  });

  it('falls through an empty override', () => {
    expect(resolveModuleTitle(input({ override: '' }))).toEqual({ moduleTitle: 'Settings', bodyclass: 'foo' });
  });

  it.each(CONTENT_MODULE_IDS.flatMap((moduleId) => ['carch', 'cArch'].map((circuit) => [circuit, moduleId])))(
    'titles %s on content module %s Site Content with sidebar-tab',
    (originalCircuit, moduleId) => {
      expect(resolveModuleTitle(carch({ originalCircuit, moduleId }))).toEqual({
        moduleTitle: 'Site Content',
        bodyclass: 'sidebar-tab',
      });
    },
  );

  it.each([
    [{ originalFuseaction: 'imagedetails' }, 'Image Details'],
    [{ originalFuseaction: 'ImageDetails', action: 'core:carch.export' }, 'Image Details'],
    [{ action: 'core:carch.export' }, 'Export Content'],
    [{ action: 'core:cArch.Export' }, 'Export Content'],
    [{ action: 'core:carch.import' }, 'Import Content'],
    [{ action: 'CORE:CARCH.IMPORT' }, 'Import Content'],
    [{}, 'Drafts'],
    [{ originalCircuit: 'CARCH', originalFuseaction: 'edit' }, 'Drafts'],
  ] as const)('titles carch %j as %s on another module', (overrides, moduleTitle) => {
    expect(resolveModuleTitle(carch(overrides))).toEqual({ moduleTitle, bodyclass: 'foo' });
  });

  it.each([
    ['csettings', 'Settings'],
    ['cprivateusers', 'Admin Users'],
    ['cpublicusers', 'Site Members'],
    ['cemail', 'Email Broadcaster'],
    ['clogin', 'Login'],
    ['cmailinglist', 'Mailing Lists'],
    ['cmessage', 'Message'],
    ['ceditprofile', 'Edit Profile'],
    ['cfeed', 'Collections'],
    ['cfilemanager', 'File Manager'],
    ['cdashboard', 'Dashboard'],
    ['ccategory', 'Categories'],
    ['cchain', 'Approval Chains'],
    ['cchangesets', 'Content Staging'],
    ['ccomments', 'Comments'],
    ['cextend', 'Class Extensions'],
    ['cperm', 'Permissions'],
    ['cplugin', 'Plugins'],
    ['cplugins', 'Plugins'],
    ['ctrash', 'Trash Bin'],
    ['cusers', 'Users'],
  ])('titles %s as %j', (originalCircuit, moduleTitle) => {
    expect(resolveModuleTitle(input({ originalCircuit, moduleId: CONTENT_MODULE_IDS[0] }))).toEqual({
      moduleTitle,
      bodyclass: 'foo',
    });
  });

  it.each([
    ['cSettings', 'Settings'],
    ['cPrivateUsers', 'Admin Users'],
    ['CUSERS', 'Users'],
  ])('matches circuit %s case-insensitively', (originalCircuit, moduleTitle) => {
    expect(resolveModuleTitle(input({ originalCircuit })).moduleTitle).toBe(moduleTitle);
  });

  it.each(['cunknown', 'cwebservice', ''])('titles unknown circuit %j empty', (originalCircuit) => {
    expect(resolveModuleTitle(input({ originalCircuit }))).toEqual({ moduleTitle: '', bodyclass: 'foo' });
  });
});

describe('templateTitleText', () => {
  it.each([
    ['Users', 'Masa CMS - Users'],
    ['', 'Masa CMS'],
  ])('joins module title %j', (moduleTitle, expected) => {
    expect(templateTitleText('Masa CMS', moduleTitle)).toBe(expected);
  });
});

describe('templateTitleElement', () => {
  it.each([
    ['Masa CMS', 'Users', '<title>Masa CMS - Users</title>'],
    ['Masa CMS', '', '<title>Masa CMS</title>'],
    ['A & B', '<x>', '<title>A &amp; B - &lt;x&gt;</title>'],
    ['A & B', '', '<title>A &amp; B</title>'],
  ])('renders %j and %j', (configTitle, moduleTitle, expected) => {
    const markup = templateTitleElement(configTitle, moduleTitle);
    expect(isSafeHtml(markup)).toBe(true);
    expect(toString(markup)).toBe(expected);
  });
});

describe('compactTitleElement', () => {
  it.each([
    ['Masa CMS', '<title>Masa CMS</title>'],
    ['A & <B>', '<title>A &amp; &lt;B&gt;</title>'],
  ])('renders %j', (configTitle, expected) => {
    const markup = compactTitleElement(configTitle);
    expect(isSafeHtml(markup)).toBe(true);
    expect(toString(markup)).toBe(expected);
  });
});
