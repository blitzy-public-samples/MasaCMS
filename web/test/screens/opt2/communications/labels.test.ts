// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rbFor } from '@/lib/resource-bundles/rb';
import { deliveryStatusScreen } from '@/screens/opt2/communications/delivery-status';
import { sendsScreen } from '@/screens/opt2/communications/sends';
import { templatesScreen } from '@/screens/opt2/communications/templates';
import { OPT2_LABEL_KEYS, type Opt2LabelName } from '@/screens/opt2/shared';
import type { Opt2ScreenDefinition } from '@/screens/registry';
import { COMMUNICATIONS_IDS, messageTemplates, messages } from '../../../fixtures/opt2/communications';
import { useTestEnv } from '../../../helpers/env';
import { routeKey, type FakeRouteTable } from '../../../helpers/fake-gateway';
import { bodyModel, listAnswer, screenContext, senderRequest } from './context';

const LOCALE = 'fr';

/** Catalogued label `name` as the French admin bundle words it. */
const fr = (name: Opt2LabelName): string => rbFor(LOCALE).rbKey(OPT2_LABEL_KEYS[name]);

/** The State column text of each delivery state: bundle-worded where catalogued, else English. */
const STATE_TEXT = { queued: fr('Queued'), sent: fr('Sent'), delivered: 'Delivered', failed: 'Failed' } as const;

const LABEL_CASES: ReadonlyArray<{
  name: string;
  def: Opt2ScreenDefinition;
  rc: Readonly<Record<string, string>>;
  routes: FakeRouteTable;
  headings: readonly string[];
  headers: ReadonlyArray<readonly string[]>;
  labels: readonly string[];
  /** Zero-based table and column of each State column, and its cell texts. */
  states: ReadonlyArray<readonly [table: number, column: number, texts: readonly string[]]>;
  pagerLinks: readonly string[];
}> = [
  {
    name: 'templates',
    def: templatesScreen,
    rc: {},
    routes: { [routeKey('GET', 'communications', '/v1/templates')]: listAnswer(messageTemplates, 1, 2) },
    headings: ['Templates', 'Add Template'],
    headers: [[fr('Name'), fr('Subject'), fr('Created'), fr('Last Update'), fr('Actions')]],
    labels: [fr('Name'), fr('Subject'), 'Text Body', 'HTML Body'],
    states: [],
    pagerLinks: [fr('Next')],
  },
  {
    name: 'sends',
    def: sendsScreen,
    rc: {},
    routes: {},
    headings: ['Sends', 'Send Message'],
    headers: [[fr('To'), fr('Subject'), fr('Template'), fr('State'), fr('Created'), fr('Sent'), fr('Actions')]],
    labels: [fr('Template'), fr('To'), fr('From'), 'Variables (JSON object)', fr('Subject'), 'Text Body', 'HTML Body'],
    states: [[0, 3, messages.map((message) => STATE_TEXT[message.state])]],
    pagerLinks: [],
  },
  {
    name: 'delivery-status',
    def: deliveryStatusScreen,
    rc: { messageId: COMMUNICATIONS_IDS.messages.delivered },
    routes: {},
    headings: ['Delivery Status', fr('History')],
    headers: [
      [fr('To'), fr('From'), fr('Subject'), fr('State'), fr('Created'), fr('Sent')],
      [fr('Status'), 'Detail', 'Mailpit ID', 'Recorded'],
    ],
    labels: [],
    states: [[1, 0, [STATE_TEXT.queued, STATE_TEXT.sent, STATE_TEXT.delivered]]],
    pagerLinks: [],
  },
];

describe('communications labels in the session locale', () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = useTestEnv();
  });
  afterEach(() => {
    restoreEnv();
  });

  it.each(LABEL_CASES)('words the catalogued labels of $name from the fr bundle', async (screen) => {
    const ctx = screenContext(senderRequest({ rc: screen.rc, session: { rb: LOCALE } }), screen.routes);
    const model = bodyModel((await screen.def.render(ctx, await screen.def.load(ctx))).body);

    expect(model.headings).toEqual(screen.headings);
    expect(model.tables.map((table) => table.headers)).toEqual(screen.headers);
    expect(model.labels).toEqual(screen.labels);
    expect(screen.states.map(([table, column]) => model.tables[table]?.rows.map((row) => row[column]))).toEqual(
      screen.states.map(([, , texts]) => texts),
    );
    expect(model.links.filter((link) => link.href.includes('pageIndex=')).map((link) => link.text)).toEqual(
      screen.pagerLinks,
    );
  });
});
