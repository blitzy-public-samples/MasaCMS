// The cArch.draft rows of carch/draft.cfm:89: every draft for S2 or the private-pool Admin of getSite(rc.siteid), else
// only drafts with an editor or author verdict.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toString } from '@/lib/html';
import { applyCarchDefaults } from '@/screens/carch/controller';
import { draftScreen, type DraftData, type DraftRow } from '@/screens/carch/draft';
import { useTestEnv } from '../../helpers/env';
import { REQUESTED_SITE_CASES } from '../../helpers/requested-site';
import { makeScreenContext } from '../../helpers/screen-context';

const FORMS = '00000000000000000000000000000000004';

/** A draft Form, titled by its history link, with node verdict `verdict`. */
const formDraft = (contentId: string, menuTitle: string, verdict: string): DraftRow => ({
  contentId,
  type: 'Form',
  parentId: FORMS,
  moduleId: FORMS,
  menuTitle,
  module: 'Forms',
  verdict,
});

const DRAFTS: DraftData = {
  rows: [
    formDraft('D1000000-0000-0000-0000000000000001', 'Edited', 'editor'),
    formDraft('D1000000-0000-0000-0000000000000002', 'Readable', 'read'),
  ],
};

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

describe('draftScreen rows', () => {
  it.each(REQUESTED_SITE_CASES)('lists every draft for $who only when it administers that site', async (testCase) => {
    const ctx = makeScreenContext({ req: applyCarchDefaults(testCase.request({ circuit: 'cArch', item: 'draft' })) });

    const view = await draftScreen.render(ctx, DRAFTS);
    const $ = cheerio.load(toString(view.body), null, false);

    expect($('td.var-width a').toArray().map((el) => $(el).text())).toEqual(
      testCase.administers ? ['Edited', 'Readable'] : ['Edited'],
    );
  });
});
