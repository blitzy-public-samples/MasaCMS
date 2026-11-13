// cform.getdialog against cform.cfc (161-163), formBuilderManager.getDialog (217-242) and html.cfm.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createResourceBundles, type RbLookup } from '@/lib/resource-bundles/rb';
import { getDialog } from '@/screens/cform/getdialog';
import { FORMBUILDER_TEMPLATES, renderFormBuilderTemplate, type NestedFormOption } from '@/screens/cform/templates';
import type { RawBody } from '@/screens/registry';
import { fixtureBundles } from '../../fixtures/resource-bundles/generated-bundles';
import { adminS2Request } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, type FakeGatewayClient } from '../../helpers/fake-gateway';
import { makeScreenContext } from '../../helpers/screen-context';

// The registry loads every circuit's screens; the screen context reads only its shell hooks.
vi.mock('@/screens/registry', () => ({ shellHooks: { secondaryMenus: {} } }));

const HTML = 'text/html;charset=UTF-8';
const MISSING_EN = 'formbuilder.missingfieldtemplatefile_missing';

const fixtureRb = createResourceBundles(fixtureBundles).rbFor('en_US');
const loadForms = (): Promise<readonly NestedFormOption[]> => Promise.resolve([]);

let restore: () => void;
let gateway: FakeGatewayClient;

beforeEach(() => {
  restore = useTestEnv();
  gateway = fakeGatewayClient({});
});

afterEach(() => {
  restore();
  expect(gateway.calls).toEqual([]);
});

/** getDialog for an S2 request carrying `rc.dialog`, labelled by `rb` or else the session bundle. */
const dialogFor = (dialog: string, rb?: RbLookup): Promise<RawBody> =>
  getDialog(
    makeScreenContext({ req: adminS2Request({ circuit: 'cform', item: 'getdialog', rc: { dialog } }), gateway, rb }),
  );

describe('getDialog', () => {
  it.each([
    ['message-delete-row', 'formbuilder.dataset.rowdeleteconfirm', 'Delete Row?'],
    ['message-dataset-sourcerequired', 'formbuilder.dataset.sourcerequired', 'You must specify a source'],
  ])('labels %s from the session bundle', async (dialog, key, enLabel) => {
    await expect(dialogFor(dialog, fixtureRb)).resolves.toEqual({
      status: 200,
      contentType: HTML,
      body: `<span>${fixtureRb.rbKey(key)}</span>`,
    });
    await expect(dialogFor(dialog)).resolves.toEqual({ status: 200, contentType: HTML, body: `<span>${enLabel}</span>` });
  });

  it('answers field-block trimmed, from the field-template set', async () => {
    const raw = await FORMBUILDER_TEMPLATES['field-block']?.({ rb: fixtureRb, loadForms });
    const body = await renderFormBuilderTemplate('field-block', { rb: fixtureRb, loadForms });

    expect(raw).not.toBe(body);
    expect(body).toBe(raw?.trim());
    await expect(dialogFor('field-block', fixtureRb)).resolves.toEqual({ status: 200, contentType: HTML, body });
  });

  it('sanitises the dialog name as legacy does', async () => {
    const expected = await dialogFor('message-delete-row');

    await expect(dialogFor('Message-Delete-Row!')).resolves.toEqual(expected);
  });

  it.each<[string, string, RbLookup | undefined, string]>([
    ['nosuch', 'the generated en bundle', undefined, `${MISSING_EN}: nosuch.cfm`],
    ['nosuch', 'the fixture bundle', fixtureRb, `${fixtureRb.rbKey('formbuilder.missingfieldtemplatefile')}: nosuch.cfm`],
    ['No Such', 'the generated en bundle', undefined, `${MISSING_EN}: nosuch.cfm`],
  ])('answers missing dialog %j with legacy message from %s', async (dialog, _bundle, rb, body) => {
    await expect(dialogFor(dialog, rb)).resolves.toEqual({ status: 200, contentType: HTML, body });
  });
});
