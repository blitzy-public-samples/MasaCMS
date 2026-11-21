import { beforeAll, describe, expect, it } from 'vitest';
import { loadCatalogue, scenarioById, type Scenario, type Step } from '../../src/golden/catalogue.js';
import { inventoryRouteKeyForRequest } from '../../src/inventory/route-keys.js';

interface KeyedStep {
  step: Step;
  index: number;
  key: string;
}

const STEP_BINDING = /^\$\{([a-zA-Z][\w-]*)\.csrfToken\}$/;

async function keyOf(step: Step, index: number): Promise<KeyedStep> {
  const url = new URL(step.route, 'http://legacy.invalid');
  const result = await inventoryRouteKeyForRequest({
    method: step.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    form: step.form ?? {},
    headers: {},
  });
  return { step, index, key: result.key };
}

describe('GS-ID-09 approval-bypass token evidence', () => {
  let scenario: Scenario;
  let steps: KeyedStep[];
  let bypass: KeyedStep;
  let source: KeyedStep;

  beforeAll(async () => {
    scenario = scenarioById(await loadCatalogue(), 'GS-ID-09');
    steps = await Promise.all(scenario.steps.map(keyOf));
    const bypasses = steps.filter((s) => s.key === 'admin:carch.approvalaction');
    expect(bypasses).toHaveLength(1);
    bypass = bypasses[0] as KeyedStep;
    const sourceName = STEP_BINDING.exec(String(bypass.step.form?.csrf_token))?.[1];
    const found = steps.find((s) => s.step.name === sourceName);
    expect(found, `approvalaction token binding ${String(bypass.step.form?.csrf_token)}`).toBeDefined();
    source = found as KeyedStep;
  });

  const bound = (field: string): string => `\${${source.step.name}.${field}}`;
  const tokenUses = (): KeyedStep[] => steps.filter((s) => s.step.form?.csrf_token === bound('csrfToken'));

  it('validates with loadCatalogue', async () => {
    await expect(loadCatalogue()).resolves.toMatchObject({ scenarios: expect.arrayContaining([scenario]) });
  });

  it('posts to approvalaction a token taken earlier from the validating cEditProfile.edit form', () => {
    expect(source.key).toBe('admin:ceditprofile.edit');
    expect(source.index).toBeLessThan(bypass.index);
    expect(source.step.extract).toMatchObject({
      csrfToken: { from: 'dom', selector: 'form[name=form1] input[name=csrf_token]', attr: 'value' },
      csrfExpires: { from: 'dom', selector: 'form[name=form1] input[name=csrf_token_expires]', attr: 'value' },
    });
    expect(bypass.step.form?.csrf_token_expires).toBe(bound('csrfExpires'));
  });

  it('submits that token to approvalaction, then cEditProfile.update, then the withheld {extdata} variant', () => {
    const uses = tokenUses().map((s) => ({
      key: s.key,
      expected: s.step.expected,
      decisionListRef: s.step.decisionListRef,
      expires: s.step.form?.csrf_token_expires,
    }));
    const expires = bound('csrfExpires');
    expect(uses).toEqual([
      { key: 'admin:carch.approvalaction', expected: undefined, decisionListRef: undefined, expires },
      { key: 'admin:ceditprofile.update', expected: undefined, decisionListRef: undefined, expires },
      {
        key: 'admin:ceditprofile.update{extdata}',
        expected: 'withheld',
        decisionListRef: 'admin:ceditprofile.update{extdata}',
        expires,
      },
    ]);
  });

  it('covers every route key the token requests compute', () => {
    const keys = [source, ...tokenUses()].map((s) => s.key);
    expect(scenario.covers).toEqual(expect.arrayContaining(keys));
  });
});
