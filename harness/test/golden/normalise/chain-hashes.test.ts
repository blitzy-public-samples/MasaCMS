import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { decodeRow, encodeRow, type CanonicalColumn } from '@opt2/platform/migration-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { loadCatalogue, scenarioById, type Scenario } from '../../../src/golden/catalogue.js';
import { GoldenConfigError } from '../../../src/golden/errors.js';
import {
  RULES_PATH,
  chainEntryVerdict,
  compareNormalised,
  compareRows,
  createIdOrdinals,
  createNormaliseState,
  loadRules,
  normaliseChainHashes,
  normaliseSideEffects,
  normaliseStep,
  type Difference,
  type NormaliseRules,
  type NormalisedStep,
  type NormalisedTable,
} from '../../../src/golden/normalise/index.js';
import type { RowSnapshot } from '../../../src/golden/side-effects.js';
import type { StepRecord } from '../../../src/golden/steps.js';

const GENESIS = '0'.repeat(64);
// SHA-256 of the GS-ES document; the `created` entry's detail.
const DOCUMENT_SHA256 = 'cbe8263992edc7f17cfdcb0d0b113055db84a88864419e372f390f0630f7057d';
const JSON_TYPE = 'application/json;charset=UTF-8';
const AUDIT_ROUTE = 'fixture:esignature/requests/{id}/audit@get';
const UNIT = 'esignature.audit_entry';
const GOLDEN_AT = ['2026-06-30T12:00:00.003', '2026-06-30T12:00:01.997'] as const;
const REPLAY_AT = ['2026-11-16T02:40:23.373', '2026-11-16T02:40:24.007'] as const;
const AUDIT_COLUMNS: CanonicalColumn[] = [
  { name: 'entry_id', type: 's' },
  { name: 'request_id', type: 's' },
  { name: 'seq', type: 'i' },
  { name: 'action', type: 's' },
  { name: 'actor_user_id', type: 's' },
  { name: 'detail', type: 's' },
  { name: 'at', type: 't' },
  { name: 'prev_hash', type: 'b' },
  { name: 'entry_hash', type: 'b' },
];

/** An audit entry as the fixture audit route lists it: `at` as FORMAT text, hashes as lowercase hex, NULL as ''. */
interface AuditEntry {
  entry_id: string;
  request_id: string;
  seq: number;
  action: string;
  actor_user_id: string;
  detail: string;
  at: string;
  prev_hash: string;
  entry_hash: string;
}

type EntryFields = Omit<AuditEntry, 'entry_id' | 'prev_hash' | 'entry_hash'>;

/** The parts of the rules document the rejected copies change. */
interface RulesDoc {
  envelope: { apply: string[] };
  chainHashes: { [key: string]: unknown; selfConsistency: { record: Record<string, string> } };
  [section: string]: unknown;
}

// Copied from services/e-signature/test/helpers/vectors.ts (checked on SQL Server 2022 with usp_audit_append).
const VECTOR_REQUEST_ID = 'ABCDEF01-2345-6789-ABCDEF0123456789';
const VECTOR_ACTOR = 'A1B2C3D4-0000-0000-0000000000000001';
const VECTORS: readonly [seq: number, action: string, detail: string, at: string, prev: string, entry: string][] = [
  [
    1,
    'created',
    DOCUMENT_SHA256,
    '2026-06-30T00:00:00.000',
    GENESIS,
    '18164a5905ad3555e39d741971514b66c24e3673ecc52c0add4a557efb6f41c0',
  ],
  [
    2,
    'signed',
    '',
    '2026-06-30T12:00:00.000',
    '18164a5905ad3555e39d741971514b66c24e3673ecc52c0add4a557efb6f41c0',
    '11c3c1d38fa8255e7123b53e6987c0b91c070bd813b74b63a5d5f27c5dd8fa8d',
  ],
  [
    4,
    'signed',
    'Zo\u00eb \u00dcnal \u2013 \u7f72\u540d',
    '2026-06-30T12:00:00.007',
    '726987f63d7392562884606119dbbbef56ed8807a7e9a580f37536d6405df8b4',
    'af3be5b25626e5f0e4b663e451c1d65981d616bed83be78ff74eddb88a19462e',
  ],
  [
    5,
    'signed',
    'Signed with \u{1F58B}',
    '2026-06-30T12:00:01.997',
    'af3be5b25626e5f0e4b663e451c1d65981d616bed83be78ff74eddb88a19462e',
    '9998930c5e2cadfacfaa6a00272bbe6554fcae68f911c15ccb7dcae48ad0229c',
  ],
];

const pad = (id: string): string => id.padEnd(35, ' ');
const sha256 = (...parts: Buffer[]): string => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
};

/** usp_audit_append's canonical text: char(35) ids padded, an empty actor left empty. */
function canonicalOf(fields: EntryFields): string {
  const actor = fields.actor_user_id === '' ? '' : pad(fields.actor_user_id);
  return [pad(fields.request_id), String(fields.seq), fields.action, actor, fields.detail, fields.at].join('|');
}

/** usp_audit_append's entry hash: SHA-256 of the prev_hash bytes then the canonical text in `encoding`. */
function hashOf(prev: string, canonical: string, encoding: BufferEncoding = 'utf16le'): string {
  return sha256(Buffer.from(prev, 'hex'), Buffer.from(canonical, encoding));
}

interface ChainSpec {
  requestId: string;
  actor: string;
  at: readonly string[];
  /** Detail of each `signed` entry after the `created` one; default `Golden Signer`. */
  signed?: readonly string[];
}

/** A request's chain: a `created` entry then one `signed` entry per later `at`, each hashed with the formula. */
function chain(spec: ChainSpec): AuditEntry[] {
  let prev = GENESIS;
  return spec.at.map((at, i) => {
    const fields: EntryFields = {
      request_id: spec.requestId,
      seq: i + 1,
      action: i === 0 ? 'created' : 'signed',
      actor_user_id: spec.actor,
      detail: i === 0 ? DOCUMENT_SHA256 : (spec.signed?.[i - 1] ?? 'Golden Signer'),
      at,
    };
    const entry: AuditEntry = { entry_id: cfUuid(), ...fields, prev_hash: prev, entry_hash: hashOf(prev, canonicalOf(fields)) };
    prev = entry.entry_hash;
    return entry;
  });
}

const goldenChain = (): AuditEntry[] => chain({ requestId: cfUuid(), actor: cfUuid(), at: GOLDEN_AT });
const replayChain = (): AuditEntry[] => chain({ requestId: cfUuid(), actor: cfUuid(), at: REPLAY_AT });

/** The fixture audit route's queryPage envelope over `items`. */
function auditEnvelope(items: readonly AuditEntry[]): string {
  return JSON.stringify({
    apiversion: 'v1',
    method: 'audit',
    params: { siteid: 'tenant-a' },
    data: {
      items,
      startindex: 1,
      endindex: items.length,
      itemsperpage: 25,
      totalitems: items.length,
      totalpages: 1,
      pageindex: 1,
    },
  });
}

function stepRecord(name: string, index: number, text: string): StepRecord {
  return {
    name,
    index,
    routeKey: AUDIT_ROUTE,
    request: { method: 'GET', url: '/legacy-fixtures/cfml/api.cfm/esignature/requests/x/audit', headers: {}, body: { kind: 'none' } },
    response: {
      status: 200,
      headers: { 'content-type': JSON_TYPE },
      contentType: JSON_TYPE,
      sha256: sha256(Buffer.from(text, 'utf8')),
      hops: [],
      text,
    },
    extracted: {},
  };
}

let dir = '';
let rules: NormaliseRules;
let auditScenario: Scenario;
let signingScenario: Scenario;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'opt2-chain-hashes-'));
  rules = loadRules(undefined, { PORT: '8500' });
  const catalogue = await loadCatalogue();
  auditScenario = scenarioById(catalogue, 'GS-ES-02');
  signingScenario = scenarioById(catalogue, 'GS-ES-01');
});

afterAll(async () => {
  if (dir !== '') await rm(dir, { recursive: true, force: true });
});

/** One scenario side: each envelope normalised as a step of `scenario`, in order, with one shared state. */
async function side(
  envelopes: readonly string[],
  scenario: Scenario = auditScenario,
  using: NormaliseRules = rules,
): Promise<NormalisedStep[]> {
  const ctx = { state: createNormaliseState(), rules: using, scenario };
  const steps: NormalisedStep[] = [];
  for (const [index, text] of envelopes.entries()) {
    steps.push(await normaliseStep(stepRecord(index === 0 ? 'audit' : `audit-${String(index)}`, index, text), ctx));
  }
  return steps;
}

function differences(golden: readonly NormalisedStep[], replay: readonly NormalisedStep[], scenario = auditScenario): Difference[] {
  return compareNormalised({ steps: golden, sideEffects: {} }, { steps: replay, sideEffects: {} }, { rules, scenario });
}

function itemsOf(step: NormalisedStep | undefined): Record<string, unknown>[] {
  return (step?.envelope as { data: { items: Record<string, unknown>[] } }).data.items;
}

describe('chain-hash rules', () => {
  it('are applied to envelopes and stored rows', () => {
    expect(rules.chainHashes.id).toBe('chain-hash');
    expect(rules.envelope.apply).toContain(rules.chainHashes.id);
    expect(rules.rows.apply).toContain(rules.chainHashes.id);
  });

  it.each<[string, (doc: RulesDoc) => void, string, string]>([
    [
      'an unknown key',
      (doc) => {
        doc.chainHashes.extra = true;
      },
      'chainHashes',
      'extra',
    ],
    [
      'a flags key, since the format is case-exact',
      (doc) => {
        doc.chainHashes.flags = 'i';
      },
      'chainHashes',
      'flags',
    ],
    [
      'no chainHashes section',
      (doc) => {
        Reflect.deleteProperty(doc, 'chainHashes');
      },
      'chainHashes',
      'chainHashes',
    ],
    [
      'an apply list naming an undeclared rule',
      (doc) => {
        doc.envelope.apply.push('chain-hashes');
      },
      'envelope/apply/8',
      'names unknown rule id chain-hashes',
    ],
    [
      'a self-consistency hash outside fields',
      (doc) => {
        doc.chainHashes.selfConsistency.record.hash = 'entryHash';
      },
      'chainHashes/selfConsistency/record/hash',
      'must be one of fields',
    ],
    [
      'a keepLiteral value that is no hash',
      (doc) => {
        doc.chainHashes.keepLiteral = ['0'];
      },
      'chainHashes/keepLiteral/0',
      'must match format',
    ],
    [
      'an upper-case keepLiteral value',
      (doc) => {
        doc.chainHashes.keepLiteral = ['F'.repeat(64)];
      },
      'chainHashes/keepLiteral/0',
      'must match format',
    ],
    [
      'a format that does not compile',
      (doc) => {
        doc.chainHashes.format = '^[0-9a-f{64}$';
      },
      'chainHashes/format',
      'valid regular expression',
    ],
    [
      'a placeholder without its ordinal slot',
      (doc) => {
        doc.chainHashes.placeholder = '<hash>';
      },
      'chainHashes/placeholder',
      '{n}',
    ],
  ])('reject a copy with %s', async (_label, mutate, pointer, message) => {
    const doc = parse(readFileSync(RULES_PATH, 'utf8')) as RulesDoc;
    mutate(doc);
    const file = path.join(dir, `${pointer.replaceAll('/', '-')}.yaml`);
    await writeFile(file, stringify(doc), 'utf8');
    let thrown: unknown;
    try {
      loadRules(file, { PORT: '8500' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GoldenConfigError);
    expect((thrown as GoldenConfigError).path).toBe(`${file}#/${pointer}`);
    expect((thrown as GoldenConfigError).message).toContain(message);
  });
});

describe('chainEntryVerdict', () => {
  it.each(VECTORS)('reproduces the SQL Server vector of seq %i as JSON and as a stored row', (...vector) => {
    const [seq, action, detail, at, prev, entry] = vector;
    const fields: EntryFields = { request_id: VECTOR_REQUEST_ID, seq, action, actor_user_id: VECTOR_ACTOR, detail, at };
    expect(hashOf(prev, canonicalOf(fields))).toBe(entry);
    expect(chainEntryVerdict({ ...fields, prev_hash: prev, entry_hash: entry }, rules.chainHashes)).toBe(true);
    const row = {
      ...fields,
      seq: String(seq),
      detail: detail === '' ? null : detail,
      prev_hash: Buffer.from(prev, 'hex'),
      entry_hash: Buffer.from(entry, 'hex'),
    };
    expect(chainEntryVerdict(row, rules.chainHashes)).toBe(true);
  });

  // HASHBYTES over usp_audit_append's CONCAT with char(35) and NULL parameters, run on SQL Server 2022.
  const NULL_ACTOR_ENTRY = '04f11e543c444b43cee61ce4254d81f62e7b6267d5da07fe5c5a50de9589f845';
  const SHORT_ACTOR_ENTRY = '585c3d810a5217d636538f0fca307b4e4b06e187cfbd4fb18ebd9adfedd2f39e';
  const signedAt = { seq: 2, action: 'signed', at: GOLDEN_AT[0], prev_hash: GENESIS };
  const shortActor = {
    seq: 3,
    action: 'signed',
    detail: 'Golden Signer',
    at: REPLAY_AT[0],
    prev_hash: '18164a5905ad3555e39d741971514b66c24e3673ecc52c0add4a557efb6f41c0',
  };
  it.each<[string, Record<string, unknown>, string]>([
    ['a NULL actor and detail rendered as empty text', { ...signedAt, actor_user_id: '', detail: '' }, NULL_ACTOR_ENTRY],
    ['a NULL actor and detail', { ...signedAt, actor_user_id: null, detail: null }, NULL_ACTOR_ENTRY],
    ['a short actor', { ...shortActor, actor_user_id: 'SHORT' }, SHORT_ACTOR_ENTRY],
    ['a short actor padded to char(35)', { ...shortActor, actor_user_id: 'SHORT'.padEnd(35) }, SHORT_ACTOR_ENTRY],
  ])('matches SQL Server for %s', (_label, fields, entry) => {
    expect(chainEntryVerdict({ request_id: VECTOR_REQUEST_ID, ...fields, entry_hash: entry }, rules.chainHashes)).toBe(true);
  });

  it('matches record fields case-insensitively and checks nothing without all of them', () => {
    const [first] = chain({ requestId: VECTOR_REQUEST_ID, actor: VECTOR_ACTOR, at: GOLDEN_AT });
    const upper = Object.fromEntries(Object.entries(first ?? {}).map(([key, value]) => [key.toUpperCase(), value]));
    expect(chainEntryVerdict(upper, rules.chainHashes)).toBe(true);
    const { at: _at, ...withoutAt } = first ?? ({} as AuditEntry);
    expect(chainEntryVerdict(withoutAt, rules.chainHashes)).toBeUndefined();
  });

  it.each(['prev_hash', 'entry_hash'] as const)('fails an entry whose %s is upper-case hex', (field) => {
    const [, signed] = chain({ requestId: VECTOR_REQUEST_ID, actor: VECTOR_ACTOR, at: GOLDEN_AT });
    if (signed === undefined) throw new Error('chain has two entries');
    expect(chainEntryVerdict({ ...signed }, rules.chainHashes)).toBe(true);
    expect(chainEntryVerdict({ ...signed, [field]: signed[field].toUpperCase() }, rules.chainHashes)).toBe(false);
  });
});

describe('normaliseChainHashes', () => {
  const HASH = '9998930c5e2cadfacfaa6a00272bbe6554fcae68f911c15ccb7dcae48ad0229c';

  it.each<[key: string, value: unknown]>([
    ['prev_hash', GENESIS],
    ['entry_hash', GENESIS],
    ['detail', DOCUMENT_SHA256],
    ['document_sha256', DOCUMENT_SHA256],
    ['entry_hash', HASH.slice(1)],
    ['entry_hash', null],
    ['Prev_Hash', HASH.toUpperCase()],
    ['entry_hash', HASH.replace(/[a-f]/, (letter) => letter.toUpperCase())],
  ])('keeps %s %j literal', (key, value) => {
    const counter = createIdOrdinals().chainHashes;
    expect(normaliseChainHashes({ [key]: value }, counter, rules.chainHashes)).toStrictEqual({ [key]: value });
    expect(counter.next).toBe(1);
  });

  it.each<[key: string, value: string]>([
    ['entry_hash', HASH],
    ['Prev_Hash', HASH],
  ])('replaces %s by its first-sight ordinal', (key, value) => {
    const counter = createIdOrdinals().chainHashes;
    const nested = { list: [{ [key]: value }, { [key]: value }] };
    expect(normaliseChainHashes(nested, counter, rules.chainHashes)).toStrictEqual({
      list: [{ [key]: '<hash:1>' }, { [key]: '<hash:1>' }],
    });
    expect(counter.next).toBe(2);
  });
});

describe('chain hashes in GS-ES-02 audit envelopes', () => {
  it('normalise two runs with other request ids, `at` and hashes alike, link structure and id ordinals intact', async () => {
    const golden = goldenChain();
    const replay = replayChain();
    const echo = (entries: AuditEntry[]): AuditEntry[] => entries.slice(1);
    const goldenSteps = await side([auditEnvelope(golden), auditEnvelope(echo(golden))]);
    const replaySteps = await side([auditEnvelope(replay), auditEnvelope(echo(replay))]);

    expect(differences(goldenSteps, replaySteps)).toStrictEqual([]);
    const [first, second] = itemsOf(goldenSteps[0]);
    expect(first).toMatchObject({ prev_hash: GENESIS, entry_hash: '<hash:1>', detail: DOCUMENT_SHA256 });
    expect(second).toMatchObject({ prev_hash: '<hash:1>', entry_hash: '<hash:2>', detail: 'Golden Signer' });
    expect(itemsOf(goldenSteps[1])[0]).toMatchObject({ prev_hash: '<hash:1>', entry_hash: '<hash:2>' });

    const withoutRule = {
      ...rules,
      envelope: { ...rules.envelope, apply: rules.envelope.apply.filter((id) => id !== rules.chainHashes.id) },
    };
    const raw = itemsOf((await side([auditEnvelope(golden)], auditScenario, withoutRule))[0]);
    const strip = ({ prev_hash: _p, entry_hash: _e, ...rest }: Record<string, unknown>): Record<string, unknown> => rest;
    expect(itemsOf(goldenSteps[0]).map(strip)).toStrictEqual(raw.map(strip));
    expect(raw[1]?.entry_hash).toBe(golden[1]?.entry_hash);
  });

  it('reports a broken link, a prev_hash that is not the previous entry_hash', async () => {
    const replay = replayChain();
    const [created, signed] = replay;
    if (created === undefined || signed === undefined) throw new Error('chain has two entries');
    const prev = sha256(Buffer.from('another chain'));
    const relinked = { ...signed, prev_hash: prev, entry_hash: hashOf(prev, canonicalOf(signed)) };

    const found = differences(await side([auditEnvelope(goldenChain())]), await side([auditEnvelope([created, relinked])]));

    expect(found.map(({ path: at, expected, actual }) => ({ at, expected, actual }))).toStrictEqual([
      { at: 'envelope.data.items[1].prev_hash', expected: '<hash:1>', actual: '<hash:3>' },
    ]);
  });

  it.each<[string, (hex: string) => string]>([
    ['upper-case', (hex) => hex.toUpperCase()],
    ['mixed-case', (hex) => hex.replace(/[a-f]/, (letter) => letter.toUpperCase())],
  ])('reports %s replay hashes against lowercase golden ones as differences', async (_label, recase) => {
    const replay = replayChain().map((entry) => ({
      ...entry,
      prev_hash: recase(entry.prev_hash),
      entry_hash: recase(entry.entry_hash),
    }));
    const [created, signed] = replay;
    if (created === undefined || signed === undefined) throw new Error('chain has two entries');

    const found = differences(await side([auditEnvelope(goldenChain())]), await side([auditEnvelope(replay)]));

    expect(found.map(({ path: at, expected, actual }) => ({ at, expected, actual }))).toStrictEqual([
      { at: 'envelope.data.items[0].entry_hash', expected: '<hash:1>', actual: created.entry_hash },
      { at: 'envelope.data.items[1].entry_hash', expected: '<hash:2>', actual: signed.entry_hash },
      { at: 'envelope.data.items[1].prev_hash', expected: '<hash:1>', actual: signed.prev_hash },
    ]);
  });

  it.each<[string, (entry: AuditEntry) => string]>([
    ['another detail', (entry) => hashOf(entry.prev_hash, canonicalOf({ ...entry, detail: 'Tampered Signer' }))],
    ['another `at` text', (entry) => hashOf(entry.prev_hash, canonicalOf({ ...entry, at: entry.at.slice(0, 19) }))],
    ['UTF-8 canonical text', (entry) => hashOf(entry.prev_hash, canonicalOf(entry), 'utf8')],
    ['no prev_hash prefix', (entry) => sha256(Buffer.from(canonicalOf(entry), 'utf16le'))],
  ])('masks an entry_hash over %s as a mismatch, which stays a difference', async (_label, wrongHash) => {
    const [created, signed] = replayChain();
    if (created === undefined || signed === undefined) throw new Error('chain has two entries');
    const replaySteps = await side([auditEnvelope([created, { ...signed, entry_hash: wrongHash(signed) }])]);

    expect(itemsOf(replaySteps[0])[1]).toMatchObject({ prev_hash: '<hash:1>', entry_hash: '<hash:mismatch>' });
    const found = differences(await side([auditEnvelope(goldenChain())]), replaySteps);
    expect(found.map(({ path: at, expected, actual }) => ({ at, expected, actual }))).toStrictEqual([
      { at: 'envelope.data.items[1].entry_hash', expected: '<hash:2>', actual: '<hash:mismatch>' },
    ]);
  });

  it('sorts a sortArrays list by its id- and hash-independent form', async () => {
    // Two `signed` entries tie until entry_hash; pick a chain whose raw hashes sort against seq order.
    const inverted = (): AuditEntry[] => {
      for (;;) {
        const at = [...GOLDEN_AT, GOLDEN_AT[1]];
        const entries = chain({ requestId: cfUuid(), actor: cfUuid(), at, signed: ['Golden Signer', 'Golden Signer'] });
        if ((entries[2]?.entry_hash ?? '') < (entries[1]?.entry_hash ?? '')) return entries;
      }
    };
    const sorting: Scenario = { ...auditScenario, normalisationOverrides: { sortArrays: ['data.items'] } };
    const golden = await side([auditEnvelope(inverted())], sorting);
    const replay = await side([auditEnvelope(inverted().reverse())], sorting);

    expect(itemsOf(golden[0]).map((item) => item.seq)).toStrictEqual([1, 2, 3]);
    expect(differences(golden, replay, sorting)).toStrictEqual([]);
  });
});

describe('chain hashes in GS-ES-01 synthetic.audit_entry rows', () => {
  /** The legacy snapshot of `entries`, in the order given. */
  function snapshot(entries: readonly AuditEntry[]): RowSnapshot {
    return {
      unit: UNIT,
      owner: 'esignature',
      legacyTable: 'synthetic.audit_entry',
      columns: AUDIT_COLUMNS,
      keyColumns: ['entry_id'],
      keyless: false,
      rows: entries.map((entry) =>
        encodeRow(AUDIT_COLUMNS, {
          ...entry,
          prev_hash: Buffer.from(entry.prev_hash, 'hex'),
          entry_hash: Buffer.from(entry.entry_hash, 'hex'),
        }),
      ),
    };
  }

  async function normalised(entries: readonly AuditEntry[]): Promise<Record<string, NormalisedTable>> {
    const effects = { mail: [], rows: { [UNIT]: snapshot(entries) }, tasks: [], files: [] };
    const out = await normaliseSideEffects(effects, { state: createNormaliseState(), rules, scenario: signingScenario });
    return out.rows ?? {};
  }

  const rehash = (entries: AuditEntry[]): AuditEntry[] =>
    entries.map((entry) => {
      if (entry.seq !== 2) return entry;
      return { ...entry, entry_hash: hashOf(entry.prev_hash, canonicalOf({ ...entry, detail: 'Tampered Signer' })) };
    });

  it.each<[string, (entries: AuditEntry[]) => AuditEntry[], boolean]>([
    ['in another row order', (entries) => [...entries].reverse(), true],
    ['with an entry_hash over another detail', rehash, false],
  ])('compare a replay %s', async (_label, mutate, equal) => {
    const golden = await normalised(goldenChain());
    const replay = await normalised(mutate(replayChain()));

    const table = golden[UNIT];
    expect(table?.columns.filter((column) => column.name.endsWith('_hash'))).toStrictEqual([
      { name: 'prev_hash', type: 's' },
      { name: 'entry_hash', type: 's' },
    ]);
    const rows = (table?.entries ?? []).map(({ encoding }) => decodeRow(table?.columns ?? [], encoding));
    expect(rows.map(({ seq, detail, prev_hash, entry_hash }) => ({ seq, detail, prev_hash, entry_hash }))).toStrictEqual([
      { seq: '1', detail: DOCUMENT_SHA256, prev_hash: GENESIS, entry_hash: '<hash:1>' },
      { seq: '2', detail: 'Golden Signer', prev_hash: '<hash:1>', entry_hash: '<hash:2>' },
    ]);
    const comparison = compareRows(golden, replay)[UNIT];
    expect(comparison?.checksumEqual).toBe(equal);
    expect(comparison?.missing.length).toBe(equal ? 0 : 1);
    if (!equal) {
      const [extra] = comparison?.extra ?? [];
      expect(decodeRow(replay[UNIT]?.columns ?? [], extra ?? '')).toMatchObject({ entry_hash: '<hash:mismatch>' });
    }
  });

  it("numbers new hashes in the order of their rows' hash-independent form", async () => {
    const columns: CanonicalColumn[] = [
      { name: 'entry_hash', type: 'b' },
      { name: 'detail', type: 's' },
    ];
    const rowsOf = (details: readonly string[]): RowSnapshot => ({
      ...snapshot([]),
      columns,
      keyColumns: [],
      keyless: true,
      rows: details.map((detail) =>
        encodeRow(columns, { entry_hash: createHash('sha256').update(cfUuid()).digest(), detail }),
      ),
    });
    const tables = async (details: readonly string[]): Promise<Record<string, NormalisedTable>> => {
      const effects = { mail: [], rows: { [UNIT]: rowsOf(details) }, tasks: [], files: [] };
      return (await normaliseSideEffects(effects, { state: createNormaliseState(), rules, scenario: signingScenario })).rows ?? {};
    };
    const golden = await tables(['a', 'b']);
    expect(compareRows(golden, await tables(['b', 'a']))[UNIT]?.checksumEqual).toBe(true);
    const table = golden[UNIT];
    const decoded = (table?.entries ?? []).map(({ encoding }) => decodeRow(table?.columns ?? [], encoding));
    expect(decoded).toStrictEqual([
      { entry_hash: '<hash:1>', detail: 'a' },
      { entry_hash: '<hash:2>', detail: 'b' },
    ]);
  });
});
