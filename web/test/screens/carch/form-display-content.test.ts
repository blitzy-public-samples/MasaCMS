import { readFileSync } from 'node:fs';
import { businessClock } from '@opt2/platform/testing';
import { describe, expect, it } from 'vitest';
import { isSafeHtml, toString } from '@/lib/html';
import { rbFor, type RbLookup } from '@/lib/resource-bundles/rb';
import {
  displayContentModel,
  displayContentState,
  endsLabel,
  renderDisplayContent,
  type DisplayContentInput,
  type DisplayContentModel,
} from '@/screens/carch/form/display-content';
import { adminS2Request, type AdminRequestPartial } from '../../helpers/admin-request';

// `cArch.edit` Scheduling panels captured from the legacy ACF 2023 server as admin (session locale en_US, server zone
// Etc/UTC), cut from the include's leading newline through its closing `</div>\n`.
const legacy = (name: string): string =>
  readFileSync(new URL(`../../fixtures/strategies-content/edit-displaycontent-${name}.html`, import.meta.url), 'utf8');

const ZONE = 'Etc/UTC';
const ROOT = '00000000000000000000000000000000001';
const CALENDAR = 'C0A1B2C3-0000-0000-0000000000000001';

/** `deserializeInterval` of a new bean's stored `Daily` with no start or stop. */
const NEW_INTERVAL = {
  type: 'Daily', every: 1, repeats: 1, allday: '1', end: 'never', endon: '', endafter: '1', daysofweek: '',
  detectconflicts: '0', detectspan: '12', timezone: ZONE,
};

interface Fixture {
  readonly rc: AdminRequestPartial['rc'];
  readonly bean: Readonly<Record<string, unknown>>;
  readonly parentBeanType: string;
  readonly model?: Readonly<Record<string, unknown>>;
  readonly rb?: RbLookup;
}

/** A new node's bean: display Always, the stored `Daily` interval, no start or stop. */
function newBean(parentType: string): Record<string, unknown> {
  return {
    display: 1, isNew: 1, displayInterval: 'Daily', parent: { type: parentType }, displayIntervalValues: NEW_INTERVAL,
    displayStartInTimezone: '', displayStopInTimezone: '',
  };
}

const FIXTURES: Readonly<Record<string, Fixture>> = {
  'new-page': { rc: { type: 'Page', parentid: ROOT }, bean: newBean('Page'), parentBeanType: 'Page' },
  'new-page-bigui': { rc: { type: 'Page', parentid: ROOT, bigui: 'schedule' }, bean: newBean('Page'), parentBeanType: 'Page' },
  'new-calendar': { rc: { type: 'Calendar', parentid: ROOT }, bean: newBean('Page'), parentBeanType: 'Page' },
  'new-calendar-child': { rc: { type: 'Page', parentid: CALENDAR }, bean: newBean('Calendar'), parentBeanType: 'Calendar' },
  'calendar-child': {
    rc: { type: 'Page', parentid: CALENDAR },
    parentBeanType: 'Calendar',
    bean: {
      display: 2,
      isNew: 0,
      displayInterval:
        '{"daysofweek":"2,4","endafter":0,"allday":0,"end":"on","endon":"August, 01 2026 00:00:00","timezone":"","repeats":1,"type":"weekly","detectconflicts":1,"detectspan":3,"every":1}',
      parent: { type: 'Calendar' },
      displayIntervalValues: {
        type: 'weekly', every: 1, repeats: 1, allday: 0, end: 'on', endon: "{ts '2026-08-01 00:00:00'}", endafter: 0,
        daysofweek: '2,4', detectconflicts: 1, detectspan: 3, timezone: ZONE,
      },
      displayStartInTimezone: "{ts '2026-07-01 10:00:00'}",
      displayStopInTimezone: '2026-08-01T11:30:00',
    },
  },
  page: {
    rc: { type: 'Page', parentid: ROOT },
    parentBeanType: 'Page',
    bean: {
      display: '2',
      isNew: false,
      displayInterval: '{"endafter":5,"allday":0,"end":"after","timezone":"America/New_York","repeats":1,"type":"monthly","every":2}',
      parent: { type: 'Page' },
      displayIntervalValues: {
        type: 'monthly', every: 2, repeats: 1, allday: 0, end: 'after', endon: '', endafter: 5, daysofweek: 2,
        detectconflicts: '0', detectspan: '12', timezone: 'America/New_York',
      },
      displayStartInTimezone: "{ts '2026-06-15 03:05:00'}",
      displayStopInTimezone: "{ts '2126-06-15 12:45:00'}",
    },
  },
  calendar: {
    rc: { type: 'Calendar', parentid: ROOT },
    parentBeanType: 'Page',
    bean: {
      display: 1, isNew: 0, displayInterval: null, parent: { type: 'Page' },
      displayIntervalValues: { ...NEW_INTERVAL, type: 'daily' }, displayStartInTimezone: null, displayStopInTimezone: null,
    },
  },
};

function editInput(fixture: Fixture): DisplayContentInput {
  const req = adminS2Request({ circuit: 'carch', item: 'edit', rc: fixture.rc });
  const ctx = { rb: fixture.rb ?? rbFor(req.session.rb), now: businessClock().now() };
  const rc = { contentBean: fixture.bean, parentBean: { type: fixture.parentBeanType }, defaultTimeZone: ZONE, ...fixture.model };
  return { ctx, req, data: { rc } };
}

function render(fixture: Fixture): { html: string; ptype: string } {
  const result = renderDisplayContent(editInput(fixture));
  expect(isSafeHtml(result.html)).toBe(true);
  return { html: toString(result.html), ptype: result.ptype };
}

/** The model of {@link FIXTURES}`.page` with `changes` laid over it. */
function pageModel(changes: Partial<DisplayContentModel>): DisplayContentModel {
  return { ...displayContentModel(editInput(FIXTURES.page as Fixture)), ...changes };
}

describe('carch.edit display content include', () => {
  it.each(Object.keys(FIXTURES))('matches the legacy include byte for byte: %s', (name) => {
    expect(render(FIXTURES[name] as Fixture).html).toBe(legacy(name));
  });

  it.each<[string, string]>([
    ['new-page', 'Page'],
    ['new-calendar', 'Page'],
    ['new-calendar-child', 'Calendar'],
    ['calendar-child', 'Calendar'],
  ])('returns the ptype the include sets: %s', (name, ptype) => {
    expect(render(FIXTURES[name] as Fixture).ptype).toBe(ptype);
  });

  it('takes a new node under a Calendar parent bean as a Calendar child scheduled per display window', () => {
    const state = displayContentState(pageModel({ isNew: true, parentType: 'Page', parentBeanType: 'calendar', display: '1' }));
    expect(state).toMatchObject({ ptype: 'Calendar', display: '2', interval: { repeats: '0', allday: '1' } });
  });

  it.each<[string, Partial<DisplayContentModel>, Record<string, string>]>([
    ['an existing Calendar child keeps its values', { parentType: 'Calendar' }, { repeats: '1', allday: '0', endafter: '5' }],
    ['a new node outside a Calendar does not repeat', { isNew: true }, { repeats: '0', allday: '0' }],
    ['an existing node keeps its values', {}, { repeats: '1', allday: '0' }],
  ])('applies the interval overrides: %s', (_case, changes, expected) => {
    expect(displayContentState(pageModel(changes)).interval).toMatchObject(expected);
  });

  it.each<[string, string]>([
    ['0', '1'],
    ['', ''],
    ['3', '3'],
  ])('turns an endAfter of %j into %j', (endafter, expected) => {
    const model = pageModel({});
    expect(displayContentState({ ...model, interval: { ...model.interval, endafter } }).interval.endafter).toBe(expected);
  });

  it.each<[string, string]>([
    ['ends', 'uends'],
    ['ends after now', 'uends uafter unow'],
    ['up\u0142ywa', 'uup\u0142uywa'],
    ['Biti\u015f', 'uBiti\u015f'],
    ['a-b_c 9x', 'ua-ub_c u9x'],
    ['\u00e9t\u00e9', '\u00e9ut\u00e9'],
    ['\u7ed3\u675f', '\u7ed3\u675f'],
  ])('prints the Ends label %j as ACF 2023 ReReplace does', (text, expected) => {
    expect(endsLabel(text)).toBe(expected);
  });

  it('sets the all-day times for the 24-hour clock when the locale has no day parts', () => {
    const input = editInput(FIXTURES['new-calendar-child'] as Fixture);
    const req = { ...input.req, session: { ...input.req.session, localeHasDayParts: false } };
    const html = toString(renderDisplayContent({ ...input, req }).html);
    expect(html).toContain(
      "\t\t\t\t$('#displayIntervalTZ').val('Etc/UTC');\n\n\t\t\t\t\n\t\t\t\t\t$('#mura-displayStartHour').val('0');\n" +
        "\t\t\t\t\t$('#mura-displayStartMinute').val('0');\n\t\t\t\t\t$('#mura-displayStopHour').val('23');\n" +
        "\t\t\t\t\t$('#mura-displayStopMinute').val('59');\n\t\t\t\t\n\n\t\t\t} else if(isCalendar) {",
    );
    expect(html).not.toContain("val('AM')");
  });

  it('lists the zones matching the tzRegex in text order, the default first', () => {
    const fixture = FIXTURES.page as Fixture;
    const zones = ['Europe/Paris', 'America/New_York', ZONE, 'America/Chicago', 'Asia/Tokyo'];
    const html = render({ ...fixture, model: { tzRegex: '^America/', availableTimeZones: zones } }).html;
    expect(html).toContain(
      '\t\t\t\t\t<div id="mura-tz-container" class="mura-control-group span4" style="display:none">\n' +
        '\t\t\t\t\t\t<label>Timezone</label>\n\t\t\t\t\t\t\n' +
        '\t\t\t\t\t\t<select name="displayIntervalTZ" id="displayIntervalTZ" class="mura-repeat-option">\n' +
        '\t\t\t\t\t\t\t<option value="Etc/UTC">\n\t\t\t\t\t\t\t\tDefault (Etc/UTC)\n\t\t\t\t\t\t\t</option>\n\t\t\t\t\t\t\t\n' +
        '\t\t\t\t\t\t\t\t\t<option value="America/Chicago">America/Chicago</option>\n\t\t\t\t\t\t\t\t\n' +
        '\t\t\t\t\t\t\t\t\t<option value="America/New_York" selected >America/New_York</option>\n\t\t\t\t\t\t\t\t\n' +
        '\t\t\t\t\t\t</select>\n\t\t\t\t\t</div>\n\t\t\t\t\t\n\t\t\t\t\t<input type="hidden" name="displayInterval"',
    );
    expect(html).not.toContain('name="displayIntervalTZ" id="displayIntervalTZ" value=');
  });

  it('selects the default zone when the interval is in it', () => {
    const fixture = FIXTURES['calendar-child'] as Fixture;
    const html = render({ ...fixture, model: { tzRegex: 'Asia', availableTimeZones: ['Asia/Tokyo', ZONE] } }).html;
    expect(html).toContain('<option value="Etc/UTC" selected >');
    expect(html).toContain('<option value="Asia/Tokyo">Asia/Tokyo</option>');
  });

  it('prints the labels raw where legacy does and attribute-encoded where it encodes them', () => {
    const rb: RbLookup = { locale: 'en_US', rbKey: (key) => (key === 'calendar.weekdayAbrev' ? 'a,b,c,d,e,f,g' : `<${key}>`), messageFormat: () => '' };
    const html = render({ ...(FIXTURES.calendar as Fixture), rb }).html;
    expect(html).toContain('data-original-title="&lt;sitemanager.content.fields.display&gt;">');
    expect(html).toContain('<div class="bigui__title">&lt;sitemanager.content.fields.displayinterval.schedule&gt;</div>');
    expect(html).toContain('\t\t\t<sitemanager.content.fields.perschedule>\n');
    expect(html).toContain("csStr += '<sitemanager.content.fields.displayinterval.every>&nbsp;'");
    expect(html).toContain('value="7"/> g</label>');
  });

  it('falls back to the zone exported as TZ when the model names no server zone', () => {
    const input = editInput(FIXTURES['new-page'] as Fixture);
    const { defaultTimeZone: _omitted, ...rc } = input.data.rc as Record<string, unknown>;
    const zone = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const html = toString(renderDisplayContent({ ...input, data: { rc } }).html);
    expect(html).toContain(`<input type="hidden" name="displayIntervalTZ" id="displayIntervalTZ" value="${zone}">`);
  });

  it.each<[string, Record<string, unknown>]>([
    ['the interval values', { contentBean: { ...newBean('Page'), displayIntervalValues: undefined } }],
    ['the parent', { contentBean: { ...newBean('Page'), parent: undefined } }],
    ['the parent bean', { parentBean: undefined }],
    ['the zone list of a tzRegex', { tzRegex: 'America' }],
  ])('rejects a model without %s', (_case, rcChanges) => {
    const input = editInput(FIXTURES['new-page'] as Fixture);
    expect(() => displayContentModel({ ...input, data: { rc: { ...input.data.rc, ...rcChanges } } })).toThrow(TypeError);
  });
});
