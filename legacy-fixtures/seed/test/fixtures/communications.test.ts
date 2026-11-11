// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { SITE_ORDER, loadConfig, parseConfig, type SeedConfig, type SiteCounts, type SiteKey } from '../../src/config.js';
import {
  FIXTURE_TABLE_SPECS,
  fixtureKeys,
  specForKey,
  type FixtureContext,
  type FixtureRow,
  type FixtureTables,
} from '../../src/fixture-tables.js';
import { buildCommunicationsFixtures } from '../../src/fixtures/communications.js';
import { buildMasa, indexMasa, type MasaData, type UserRow } from '../../src/masa.js';
import { createRandom } from '../../src/random.js';
import { createCalendar } from '../../src/time.js';

const CONFIG_PATH = fileURLToPath(new URL('../../seed.config.json', import.meta.url));
const DDL_PATH = fileURLToPath(new URL('../../../sql/communications/100_tables.sql', import.meta.url));
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{2}0$/;
const TEMPLATE = 'synthetic.message_template';
const MESSAGE = 'synthetic.message';
const STATUS = 'synthetic.delivery_status';
const SENDER_ROLE = 'communications.sender';
const KIND_NAMES: readonly string[] = [
  'Welcome', 'Password Reminder', 'Event Invitation', 'Monthly Newsletter', 'Survey Invitation',
  'Timesheet Reminder', 'Approval Request', 'Account Update', 'Policy Notice', 'Weekly Digest',
];
const HISTORIES: Readonly<Record<string, readonly (readonly [string, string | null])[][]>> = {
  sent: [[['sent', null]]],
  delivered: [[['sent', null], ['delivered', null]]],
  failed: [[['failed', 'smtp-error']], [['sent', null], ['failed', 'mailpit-not-found']]],
};

interface DdlColumn {
  name: string;
  type: string;
  length: number | null;
  nullable: boolean;
}

type RawConfig = { historyDays: number; emailDomain: string; sites: Record<SiteKey, { counts: Partial<SiteCounts> }> };

/** Columns of each `CREATE TABLE` block of a DDL file by dataset key, in catalog order. */
function parseDdl(sql: string): Map<string, DdlColumn[]> {
  const tables = new Map<string, DdlColumn[]>();
  for (const [, schema = '', table = '', body = ''] of sql.matchAll(/CREATE TABLE \[([^\]]+)\]\.\[([^\]]+)\] \(([\s\S]*?)\n\s*\) ON /g)) {
    const columns = [...body.matchAll(/^\s*\[([^\]]+)\] \[([a-z]+)\](?: \((\d+|max)\))? (NOT NULL|NULL)/gm)].map(
      ([, name = '', type = '', length, nullability]): DdlColumn => ({
        name,
        type,
        length: length === undefined || length === 'max' ? null : Number(length),
        nullable: nullability === 'NULL',
      }),
    );
    tables.set(`${schema}.${table}`, columns);
  }
  return tables;
}

let raw: RawConfig;
let config: SeedConfig;
let masa: MasaData;
let base: FixtureContext;
let tables: FixtureTables;
let ddl: Map<string, DdlColumn[]>;

/** Fixture context over `c`, building the Masa part from the same seed unless `data` is given. */
function contextFor(c: SeedConfig, data?: MasaData): FixtureContext {
  const random = createRandom(c.seed);
  const calendar = createCalendar(c.businessDate);
  const built = data ?? buildMasa(c, random.fork('masa'), calendar);
  return { config: c, random: random.fork('fixtures/communications'), calendar, masa: built, index: indexMasa(built, c) };
}

/** Seed configuration parsed from a copy of `seed.config.json` changed by `edit`. */
function variant(edit: (copy: RawConfig) => void): SeedConfig {
  const copy = structuredClone(raw);
  edit(copy);
  return parseConfig(copy);
}

/** Rows of dataset key `key`; throws when the key is absent. */
function rows(t: FixtureTables, key: string): FixtureRow[] {
  const found = t[key];
  if (found === undefined) throw new Error(`${key} is not in the fixture tables`);
  return found;
}

/** String value of `column`; throws when it is not a string. */
function text(row: FixtureRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new TypeError(`${column} is ${JSON.stringify(value)}, not a string`);
  return value;
}

/** Rows of each communications table belonging to `site`; status rows follow their message. */
function siteRows(t: FixtureTables, site: SiteKey): FixtureTables {
  const messages = rows(t, MESSAGE).filter((row) => row.siteID === site);
  const ids = new Set(messages.map((row) => row.message_id));
  return {
    [TEMPLATE]: rows(t, TEMPLATE).filter((row) => row.siteID === site),
    [MESSAGE]: messages,
    [STATUS]: rows(t, STATUS).filter((row) => ids.has(row.message_id)),
  };
}

/** Minutes from timestamp `a` to timestamp `b`, fractional when their milliseconds differ. */
function minutesBetween(a: string, b: string): number {
  return (Date.parse(`${b}Z`) - Date.parse(`${a}Z`)) / 60_000;
}

/** `template` with each `{{key}}` of `values` replaced. */
function fill(template: string, values: Readonly<Record<string, string>>): string {
  return Object.entries(values).reduce((out, [key, value]) => out.replaceAll(`{{${key}}}`, value), template);
}

/** Every non-null value of a DDL `datetime` column across the tables. */
function datetimes(t: FixtureTables): string[] {
  return [...ddl].flatMap(([key, columns]) =>
    rows(t, key).flatMap((row) =>
      columns.filter((column) => column.type === 'datetime' && row[column.name] !== null).map((column) => text(row, column.name)),
    ),
  );
}

/** Status rows grouped by message id, each group in row order. */
function historyByMessage(t: FixtureTables): Map<string, FixtureRow[]> {
  const out = new Map<string, FixtureRow[]>();
  for (const row of rows(t, STATUS)) {
    const id = text(row, 'message_id');
    out.set(id, [...(out.get(id) ?? []), row]);
  }
  return out;
}

beforeAll(async () => {
  raw = JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as RawConfig;
  config = await loadConfig(CONFIG_PATH);
  base = contextFor(config);
  masa = base.masa;
  tables = buildCommunicationsFixtures(base);
  ddl = parseDdl(await readFile(DDL_PATH, 'utf8'));
});

describe('communications tables', () => {
  it('returns exactly the communications dataset keys, in registry order', () => {
    expect(Object.keys(tables)).toEqual(fixtureKeys(config).filter((key) => specForKey(key).spec.module === 'communications'));
    expect(Object.keys(tables)).toEqual([TEMPLATE, MESSAGE, STATUS]);
  });

  it.each([TEMPLATE, MESSAGE, STATUS])('%s rows follow the DDL column order, nullability and sizes', (key) => {
    const columns = ddl.get(key);
    expect(columns?.length).toBeGreaterThan(0);
    expect(rows(tables, key).length).toBeGreaterThan(0);
    for (const row of rows(tables, key)) {
      expect(Object.keys(row)).toEqual(columns?.map((column) => column.name));
      for (const column of columns ?? []) {
        const value = row[column.name];
        if (!column.nullable) expect(value).not.toBeNull();
        if (value === null || value === undefined) continue;
        expect(typeof value).toBe('string');
        const size = String(value).length;
        if (column.type === 'char') expect(size).toBe(column.length);
        else if (column.length !== null) expect(size).toBeLessThanOrEqual(column.length);
        if (column.type === 'datetime') expect(value).toMatch(TS);
      }
    }
  });

  it('keys every row by a unique CF UUID', () => {
    const ids = FIXTURE_TABLE_SPECS.filter((entry) => entry.module === 'communications').flatMap((entry) =>
      rows(tables, `synthetic.${entry.table}`).map((row) => text(row, entry.key)),
    );
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(CF_UUID);
  });

  it.each(SITE_ORDER.map((site) => [site]))('%s holds its configured template and message counts', (site) => {
    const { messageTemplates, messages } = config.sites[site].counts;
    const own = siteRows(tables, site);
    expect(rows(own, TEMPLATE)).toHaveLength(messageTemplates);
    expect(rows(own, MESSAGE)).toHaveLength(messages);
    expect(rows(own, STATUS).length).toBeGreaterThanOrEqual(messages);
    expect(rows(own, STATUS).length).toBeLessThanOrEqual(2 * messages);
    if (messages >= 3) expect(new Set(rows(own, MESSAGE).map((row) => row.state))).toEqual(new Set(['sent', 'delivered', 'failed']));
  });

  it('matches the seed.config.json counts per site', () => {
    const counts = SITE_ORDER.map((site) => {
      const own = siteRows(tables, site);
      return [site, rows(own, TEMPLATE).length, rows(own, MESSAGE).length];
    });
    expect(counts).toEqual([
      ['umbrella', 0, 0],
      ['tenant-a', 10, 200],
      ['tenant-b', 3, 20],
    ]);
  });

  it('dates every row before the business date', () => {
    const midnight = base.calendar.localTimestamp(0, 0);
    expect(midnight).toBe(`${config.businessDate}T00:00:00.000`);
    const stamps = datetimes(tables);
    expect(stamps.length).toBeGreaterThan(rows(tables, STATUS).length);
    expect(stamps.filter((stamp) => stamp >= midnight)).toEqual([]);
  });
});

describe('message templates', () => {
  it('names templates by kind, with placeholder bodies in matching text and HTML paragraphs', () => {
    for (const site of SITE_ORDER) {
      const templates = rows(siteRows(tables, site), TEMPLATE);
      expect(templates.map((row) => row.name)).toEqual(KIND_NAMES.slice(0, templates.length));
      for (const row of templates) {
        expect(text(row, 'subject')).toMatch(/\{\{(siteName|firstName)\}\}/);
        const paragraphs = text(row, 'body_text').split('\n\n');
        expect(paragraphs[0]).toBe('Hello {{firstName}} {{lastName}},');
        expect(paragraphs.at(-1)).toBe('{{siteName}}');
        expect(paragraphs.length).toBeGreaterThanOrEqual(4);
        expect(paragraphs.length).toBeLessThanOrEqual(5);
        const html = text(row, 'body_html').split('\n');
        for (const line of html) expect(line).toMatch(/^<p>.+<\/p>$/);
        expect(html.map((line) => line.slice(3, -4))).toEqual(paragraphs);
      }
    }
  });

  it('creates templates in the first eighth of the history window and edits them within the next eighth', () => {
    const span = (config.historyDays * 1440) / 8;
    const windowStart = base.calendar.localTimestamp(-config.historyDays, 0);
    for (const row of rows(tables, TEMPLATE)) {
      const created = text(row, 'created');
      const sinceStart = minutesBetween(windowStart, created);
      expect(sinceStart).toBeGreaterThanOrEqual(0);
      expect(sinceStart).toBeLessThan(span + 1);
      const edit = minutesBetween(created, text(row, 'lastUpdate'));
      expect(Number.isInteger(edit)).toBe(true);
      expect(edit).toBeGreaterThanOrEqual(0);
      expect(edit).toBeLessThanOrEqual(span);
    }
    expect(rows(tables, TEMPLATE).some((row) => row.created !== row.lastUpdate)).toBe(true);
  });
});

describe('messages', () => {
  it('render a template of their own site for the recipient after its last edit', () => {
    const templates = new Map(rows(tables, TEMPLATE).map((row) => [row.template_id, row]));
    const userByEmail = new Map<string, UserRow>(masa.users.map((user) => [user.email, user]));
    for (const message of rows(tables, MESSAGE)) {
      const template = templates.get(message.template_id);
      const recipient = userByEmail.get(text(message, 'to_address'));
      expect(template?.siteID).toBe(message.siteID);
      expect(recipient).toBeDefined();
      if (template === undefined || recipient === undefined) continue;
      const siteName = base.index.site(text(message, 'siteID') as SiteKey).site;
      const values = { firstName: recipient.fname, lastName: recipient.lname, siteName };
      for (const column of ['subject', 'body_text', 'body_html']) {
        expect(message[column]).toBe(fill(text(template, column), values));
        expect(message[column]).not.toContain('{{');
      }
      expect(text(message, 'created') > text(template, 'lastUpdate')).toBe(true);
    }
  });

  it('go to unreserved seed users of their own site, from its communications.sender actors', () => {
    const userByEmail = new Map<string, UserRow>(masa.users.map((user) => [user.email, user]));
    for (const site of ['tenant-a', 'tenant-b'] as const) {
      const senders = new Set(base.index.actors(site, SENDER_ROLE).map((id) => base.index.user(id).email));
      const messages = rows(siteRows(tables, site), MESSAGE);
      for (const message of messages) {
        const recipient = userByEmail.get(text(message, 'to_address'));
        expect(recipient?.siteID).toBe(site);
        expect(base.index.isReserved(recipient?.userID ?? '')).toBe(false);
        expect(text(message, 'to_address').endsWith(`@${config.emailDomain}`)).toBe(true);
        expect(senders.has(text(message, 'from_address'))).toBe(true);
      }
      expect(new Set(messages.map((message) => message.to_address)).size).toBeGreaterThan(1);
    }
  });
});

describe('delivery status', () => {
  it('records the history each final state implies, in message order and time order', () => {
    const histories = historyByMessage(tables);
    const messages = rows(tables, MESSAGE);
    expect(new Set(histories.keys())).toEqual(new Set(messages.map((row) => row.message_id)));
    expect(rows(tables, STATUS).map((row) => row.message_id)).toEqual(
      messages.flatMap((row) => (histories.get(text(row, 'message_id')) ?? []).map(() => row.message_id)),
    );
    const seen = new Set<string>();
    for (const message of messages) {
      const state = text(message, 'state');
      const steps = histories.get(text(message, 'message_id')) ?? [];
      const shape = steps.map((step) => [step.status, step.detail]);
      expect(HISTORIES[state]).toContainEqual(shape);
      seen.add(JSON.stringify(shape));
      expect(steps.at(-1)?.status).toBe(state);
      const first = minutesBetween(text(message, 'created'), text(steps[0] ?? {}, 'recorded_at'));
      expect(first).toBeGreaterThanOrEqual(0);
      expect(first).toBeLessThanOrEqual(2);
      for (let i = 1; i < steps.length; i += 1) {
        const gap = minutesBetween(text(steps[i - 1] ?? {}, 'recorded_at'), text(steps[i] ?? {}, 'recorded_at'));
        expect(gap).toBeGreaterThanOrEqual(1);
        expect(gap).toBeLessThanOrEqual(15);
      }
      expect(message.sent_at).toBe(steps.find((step) => step.status === 'sent')?.recorded_at ?? null);
      for (const step of steps) expect(step.mailpit_id).toBeNull();
    }
    expect(seen).toEqual(new Set(Object.values(HISTORIES).flat().map((shape) => JSON.stringify(shape))));
  });
});

describe('determinism', () => {
  it('same seed gives identical output; a different seed changes it', () => {
    expect(JSON.stringify(buildCommunicationsFixtures(contextFor(config, masa)))).toBe(JSON.stringify(tables));
    expect(JSON.stringify(buildCommunicationsFixtures(contextFor(config)))).toBe(JSON.stringify(tables));
    const other = buildCommunicationsFixtures(contextFor({ ...config, seed: config.seed + 1 }));
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(tables));
    expect(rows(other, MESSAGE)[0]?.message_id).not.toBe(rows(tables, MESSAGE)[0]?.message_id);
  });

  it('draws each site from its own stream', () => {
    const edited = variant((copy) => Object.assign(copy.sites['tenant-a'].counts, { messages: 50 }));
    const changed = buildCommunicationsFixtures(contextFor(edited, masa));
    expect(rows(siteRows(changed, 'tenant-a'), MESSAGE)).toHaveLength(50);
    expect(siteRows(changed, 'tenant-b')).toEqual(siteRows(tables, 'tenant-b'));
  });
});

describe('edge configurations', () => {
  it.each([
    ['no templates or messages', 0, 0, [], []],
    ['templates without messages', 3, 0, KIND_NAMES.slice(0, 3), []],
    ['one message', 1, 1, ['Welcome'], ['delivered']],
    ['two messages', 2, 2, KIND_NAMES.slice(0, 2), ['delivered', 'sent']],
    ['three messages', 3, 3, KIND_NAMES.slice(0, 3), ['delivered', 'failed', 'sent']],
    ['more templates than kinds', 12, 4, [...KIND_NAMES, 'Welcome 2', 'Password Reminder 2'], ['delivered', 'failed', 'sent']],
  ] as const)('tenant-b with %s', (_label, messageTemplates, messages, names, states) => {
    const edited = variant((copy) => Object.assign(copy.sites['tenant-b'].counts, { messageTemplates, messages }));
    const out = buildCommunicationsFixtures(contextFor(edited, masa));
    expect(Object.keys(out)).toEqual([TEMPLATE, MESSAGE, STATUS]);
    const own = siteRows(out, 'tenant-b');
    expect(rows(own, TEMPLATE).map((row) => row.name)).toEqual(names);
    expect(rows(own, MESSAGE)).toHaveLength(messages);
    expect([...new Set(rows(own, MESSAGE).map((row) => text(row, 'state')))].sort()).toEqual(states);
    expect([...historyByMessage(own).keys()]).toEqual(rows(own, MESSAGE).map((row) => row.message_id));
    expect(rows(out, STATUS)).toHaveLength(rows(siteRows(out, 'tenant-a'), STATUS).length + rows(own, STATUS).length);
    expect(siteRows(out, 'tenant-a')).toEqual(siteRows(tables, 'tenant-a'));
  });

  it('keeps every row inside a one-day history window that ends before the business date', () => {
    const edited = variant((copy) => {
      copy.historyDays = 1;
      copy.sites['tenant-b'].counts.messages = 2000;
    });
    const out = buildCommunicationsFixtures(contextFor(edited, masa));
    expect(rows(siteRows(out, 'tenant-b'), MESSAGE)).toHaveLength(2000);
    const windowStart = base.calendar.localTimestamp(-1, 0);
    const midnight = base.calendar.localTimestamp(0, 0);
    expect(datetimes(out).filter((stamp) => stamp < windowStart || stamp >= midnight)).toEqual([]);
  });

  it.each([
    ['tenant-b without templates', 'tenant-b', 5, (copy: RawConfig) => {
      Object.assign(copy.sites['tenant-b'].counts, { messageTemplates: 0, messages: 5 });
    }],
    ['umbrella without sender actors', 'umbrella', 1, (copy: RawConfig) => {
      Object.assign(copy.sites.umbrella.counts, { messageTemplates: 1, messages: 1 });
    }],
    ['an email domain no seed user has', 'tenant-a', 200, (copy: RawConfig) => {
      copy.emailDomain = 'elsewhere.test';
    }],
  ] as const)('rejects %s', (_label, site, count, edit) => {
    const run = (): FixtureTables => buildCommunicationsFixtures(contextFor(variant(edit), masa));
    expect(run).toThrow(RangeError);
    expect(run).toThrow(`Site ${site} needs templates, ${SENDER_ROLE} actors and seed users for ${count} messages`);
  });

  it('rejects a registry that lacks one of its tables', async () => {
    onTestFinished(() => {
      vi.doUnmock('../../src/fixture-tables.js');
      vi.resetModules();
    });
    vi.doMock('../../src/fixture-tables.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/fixture-tables.js')>();
      return { ...actual, FIXTURE_TABLE_SPECS: actual.FIXTURE_TABLE_SPECS.filter((entry) => entry.table !== 'delivery_status') };
    });
    vi.resetModules();
    const { buildCommunicationsFixtures: build } = await import('../../src/fixtures/communications.js');
    expect(() => build(base)).toThrow(new RangeError('No communications fixture table delivery_status in the registry'));
  });
});
