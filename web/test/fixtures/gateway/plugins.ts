import type { components } from '@/generated/clients/gateway';

type LegacyPlugin = components['schemas']['LegacyPlugin'];

/** `getLegacyPlugins` rows with a golden plugin deployed, and a second plugin escaping its texts. */
export const LEGACY_PLUGINS: readonly Readonly<LegacyPlugin>[] = Object.freeze([
  Object.freeze({
    moduleId: '88C48C97-ADFA-018D-66EAB47267C52ED2',
    name: 'OPT-2 Utility Plugin',
    directory: '1',
    category: 'Utility',
    version: '1.0.0',
    provider: 'OPT-2 golden harness',
    providerUrl: 'https://opt2.invalid/golden-plugin',
    pluginId: '1',
  }),
  Object.freeze({
    moduleId: '9A1B2C3D-4E5F-6A7B-8C9D0E1F2A3B4C5D',
    name: "O'Brien & <Co>",
    directory: 'obrien',
    category: '',
    version: '2.0',
    provider: 'A & B',
    providerUrl: '',
    pluginId: '12',
  }),
]);
