// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
// The surveys module's registrations: slugs, owning service, roles, the OPT-2 nav link, and legacy admin classes only.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { surveysActions, surveysScreens } from '@/screens/opt2/surveys';
import { OPT2_NAV_MODULES } from '@/shell/nav';
import { SURVEY_IDS } from '../../../fixtures/opt2/surveys';
import { useTestEnv } from '../../../helpers/env';
import { bodyHtml, managerRequest, surveysGateway } from './context';

// The registry loads every circuit's screens; the screen context reads only its shell hooks.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

/** Legacy admin classes the synthetic screens are built from. */
const LEGACY_CLASSES = new Set([
  'mura-header',
  'nav-module-specific',
  'btn-group',
  'btn',
  'mura-primary',
  'block',
  'block-constrain',
  'block-bordered',
  'block-content',
  'mura-table-grid',
  'var-width',
  // Responsive grid columns, as admin/core/views/cusers/inc/dsp_users_list.cfm hides secondary columns.
  'hidden-xs',
  'hidden-sm',
  'help-block',
  'help-block-empty',
  'mura-control-group',
  'mura-actions',
  'form-actions',
  'alert',
  'alert-error',
  'actions',
  'show-actions',
  'mi-ellipsis-v',
  'actions-menu',
  'hide',
  'actions-list',
  'mi-calendar',
  'mi-bullseye',
  'mi-list-alt',
  'table-responsive',
  'hidden-xs',
  'hidden-sm',
  'hidden-md',
  'title',
  // State badges, styled by admin.css `.mura .label-success`, `-info`, `-inverse` and `-important`.
  'label',
  'label-success',
  'label-info',
  'label-inverse',
  'label-important',
  // The numbered pager, as admin/core/views/cusers/inc/dsp_nextn.cfm and carch/search.cfm page a list.
  'pagination',
  'mura-layout-row',
  'clearfix',
  'search-showing',
  'pull-right',
  'active',
  'mi-angle-left',
  'mi-angle-right',
]);

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = useTestEnv();
});
afterEach(() => restoreEnv());

describe('surveys registrations', () => {
  it('registers the list, schedule, targets and responses screens and the schedule and bulk-target actions', () => {
    expect(surveysScreens.map(({ screen }) => screen)).toEqual(['surveys', 'schedule', 'targets', 'responses']);
    expect(surveysActions.map(({ action }) => action)).toEqual(['schedule', 'bulk-target']);
  });

  it.each([
    ...surveysScreens.map((def) => ({ name: `screen ${def.screen}`, def })),
    ...surveysActions.map((def) => ({ name: `action ${def.action}`, def })),
  ])('gives $name to the surveys service for surveys.manager, leaving access to the service', ({ def }) => {
    expect(def).toMatchObject({ module: 'surveys', service: 'surveys', roles: ['surveys.manager'] });
    expect(def.gate).toBeUndefined();
  });

  it('serves the OPT-2 nav link of the module', () => {
    const nav = OPT2_NAV_MODULES.find(({ module }) => module === 'surveys');

    expect(surveysScreens.some(({ screen }) => screen === nav?.screen)).toBe(true);
  });

  it.each(surveysScreens.map(({ screen }) => screen))('builds %s from legacy admin classes only', async (screen) => {
    const html = await bodyHtml(screen, managerRequest({ surveyid: SURVEY_IDS.multiSiteSurvey }), surveysGateway());

    const classes = [...html.matchAll(/ class="([^"]*)"/g)].flatMap(([, list]) => (list ?? '').split(' '));
    expect(classes.length).toBeGreaterThan(0);
    expect(classes.filter((name) => !LEGACY_CLASSES.has(name))).toEqual([]);
  });

  it.each(['schedule', 'targets'])('ends a block with the %s form and its in-flow action row', async (screen) => {
    const html = await bodyHtml(screen, managerRequest({ surveyid: SURVEY_IDS.multiSiteSurvey }), surveysGateway());
    const $ = cheerio.load(html, null, false);
    const form = $('form[name="form1"]');

    expect($('.mura-actions')).toHaveLength(0);
    expect(form.parent().is('.block-content')).toBe(true);
    expect(form.nextAll()).toHaveLength(0);
    expect(form.children().last().is('.form-actions')).toBe(true);
    expect(form.closest('.block-constrain').next('.block-constrain').find('h2').length).toBeGreaterThan(0);
  });
});
