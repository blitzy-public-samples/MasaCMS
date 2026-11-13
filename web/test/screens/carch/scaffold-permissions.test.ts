// The Custom Entities Permissions button of carch/scaffold.cfm:76: S2 or the private-pool Admin of getSite(rc.siteid).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toString } from '@/lib/html';
import { rbFor } from '@/lib/resource-bundles/rb';
import { scaffold } from '@/screens/carch/partials/scaffold';
import { useTestEnv } from '../../helpers/env';
import { REQUESTED_SITE_CASES } from '../../helpers/requested-site';

const SCAFFOLD_MODULE_ID = '00000000000000000000000000000000016';

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

describe('scaffold Permissions button', () => {
  it.each(REQUESTED_SITE_CASES)('renders for $who only when it administers that site', ({ request, administers }) => {
    const req = request({ circuit: 'cArch', item: 'list' });
    const markup = toString(scaffold({ req, rb: rbFor('en_US') }, { siteId: req.rc.siteid ?? '' }));

    expect(markup.includes(`<a class="btn" href="./?muraAction=cPerm.module&contentid=${SCAFFOLD_MODULE_ID}&`)).toBe(
      administers,
    );
  });
});
