/** Unit suite for the site settings bean's validate() port in src/legacy/validation.ts. */
import { describe, expect, it } from 'vitest';
import { applySet, newSiteBean, type SiteBean } from '../../src/legacy/site-fields.js';
import { SITE_ERROR_INVALID, SITE_ERROR_REQUIRED, validateSite } from '../../src/legacy/validation.js';

function beanWithSiteId(siteId: string): SiteBean {
  return applySet(newSiteBean(), { siteID: siteId });
}

describe('validateSite', () => {
  it('uses the legacy messages byte for byte, == typo included', () => {
    expect(SITE_ERROR_REQUIRED).toBe("The 'SiteID' variable == required.");
    expect(SITE_ERROR_INVALID).toBe("The 'SiteID' variable == invalid.");
  });

  it('reports an empty site id as required', () => {
    const errors = validateSite(beanWithSiteId(''));
    expect(errors).toStrictEqual({ siteid: SITE_ERROR_REQUIRED });
  });

  it.each(['admin', 'ADMIN', 'Admin', 'tasks', 'TASKS', 'Tasks'])(
    'reports the reserved site id %s as invalid, case-insensitively',
    (siteId) => {
      const errors = validateSite(beanWithSiteId(siteId));
      expect(errors).toStrictEqual({ siteid: SITE_ERROR_INVALID });
    },
  );

  it.each(['default', 'tenant-a', 'umbrella', 'administrator', 'task', 'admins'])(
    'accepts the site id %s',
    (siteId) => {
      const errors = validateSite(beanWithSiteId(siteId));
      expect(errors).toStrictEqual({});
    },
  );

  it('recomputes the errors on every call', () => {
    const reserved = beanWithSiteId('admin');
    expect(validateSite(reserved)).toStrictEqual({ siteid: SITE_ERROR_INVALID });

    const errors = validateSite(applySet(reserved, { siteID: 'default' }));
    expect(errors).toStrictEqual({});
  });
});
