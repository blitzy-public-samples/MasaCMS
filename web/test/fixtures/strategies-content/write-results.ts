import type { components } from '@/generated/clients/strategies-content';
import { CONTENT_HIST_IDS, CONTENT_IDS, carchEditExistingPage } from './carch';

type AdminWriteResult = components['schemas']['AdminWriteResult'];
type Struct = Readonly<Record<string, unknown>>;

const SITE = 'tenant-a';
const TITLE_REQUIRED = { title: "The 'Title' field is required" } as const;

// The contract carries a redirect as `adminUrl` parts; FW/1's `./` path and `fw1pk` preserve key are web's.
export const writeResultRedirectAppend: AdminWriteResult = {
  saved: true,
  errors: {},
  redirect: {
    circuit: 'cArch',
    action: 'list',
    params: [
      ['topid', '00000000000000000000000000000000001'],
      ['siteid', SITE],
      ['startrow', '1'],
      ['moduleid', '00000000000000000000000000000000000'],
    ],
  },
};

export const writeResultRedirectPreserve: AdminWriteResult = {
  saved: true,
  errors: {},
  redirect: { circuit: 'cComments', action: 'default', params: [] },
};

const aboutUsBean = carchEditExistingPage.rc['contentBean'] as Struct;

export const writeResultReRender: AdminWriteResult = {
  saved: false,
  errors: { ...TITLE_REQUIRED },
  redirect: null,
  data: {
    ...carchEditExistingPage.rc,
    contentBean: {
      ...aboutUsBean,
      contentID: CONTENT_IDS.aboutUs,
      contentHistID: CONTENT_HIST_IDS.aboutUs,
      title: '',
      errors: { ...TITLE_REQUIRED },
    },
  },
};
