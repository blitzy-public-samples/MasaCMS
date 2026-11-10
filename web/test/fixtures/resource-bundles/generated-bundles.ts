import type { GeneratedBundles } from '@/lib/resource-bundles/rb';

export const fixtureBundles: GeneratedBundles = {
  admin: {
    dir: 'core/mura/resourceBundle/resources',
    files: {
      de: {
        entries: [
          ['layout.adduser', 'Benutzer hinzuf&uuml;gen'],
          ['layout.help', 'Hilfe'],
          ['layout.users', 'Benutzer'],
        ],
      },
      en: {
        entries: [
          ['layout.addgroup', 'Add Group'],
          ['layout.adduser', 'Add User'],
          ['layout.dashboard', 'Dashboard'],
          ['layout.help', 'Help'],
          ['layout.users', 'Users'],
          ['opt2test.pattern', '[{0}] Last {1} Days'],
          ['sitemanager.addcontent', 'Add Content'],
          ['sitemanager.addfolder', 'Folder'],
          ['user.address', 'Address'],
          ['user.adduser', 'Add User'],
        ],
      },
      fr: { error: 'Malformed \\uxxxx encoding.' },
    },
  },
  coreAssets: {
    dir: 'core/modules/v1/core_assets/resource_bundles',
    files: {
      en: {
        entries: [['calendar.agendaweek', 'Agenda Week']],
      },
    },
  },
  global: {
    dir: 'resource_bundles',
    files: {
      en: {
        entries: [
          ['global.mycustomkey', 'success'],
          ['layout.help', 'Site Help'],
        ],
      },
    },
  },
};
