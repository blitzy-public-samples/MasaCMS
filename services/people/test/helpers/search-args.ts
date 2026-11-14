/** Viewer scopes and admin criteria shared by the offline and PostgreSQL search suites. */
import { tenantIdForSite } from '@opt2/platform/tenancy';
import { newAdvancedSearchCriteria, viewerScope, type AdvancedSearchCriteria, type SearchParamEntry, type ViewerScope } from '../../src/domain/search.js';
import type { TestActor } from './fixtures.js';

/** The viewer of an actor's verified claims; its tenant is the one its site resolves to. */
export function viewerOf(actor: TestActor, s2: boolean = actor.s2): ViewerScope {
  return viewerScope({ tid: tenantIdForSite(actor.site), site: actor.site, s2 });
}

/** Admin criteria holding `paramArray`, as admin request start-up stores them. */
export function criteriaOf(paramArray: SearchParamEntry[]): AdvancedSearchCriteria {
  return { ...newAdvancedSearchCriteria(), paramArray, paramCount: paramArray.length };
}
