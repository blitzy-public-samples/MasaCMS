import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isSafeHtml, toString } from '@/lib/html';
import { rbFor, type RbLookup } from '@/lib/resource-bundles/rb';
import { renderChangesetsDialog, type ChangesetsDialogInput } from '@/screens/carch/form/changesets';

// `cArch.edit` of Home on the default site (change sets on), captured from the legacy ACF 2023 server as admin and
// cut from the include's leading newline through `</div>\n`.
const LEGACY = readFileSync(
  new URL('../../fixtures/strategies-content/edit-changesets-dialog.html', import.meta.url),
  'utf8',
);

const CHANGESET_ID = 'C0FFEE00-1234-5678-9ABCDEF012345678';
const HOME: ChangesetsDialogInput = { currentChangesetIsNew: true, approved: true, changesetId: '' };

function render(input: Partial<ChangesetsDialogInput>, rb: RbLookup = rbFor('en')): string {
  const markup = renderChangesetsDialog({ rb }, { ...HOME, ...input });
  expect(isSafeHtml(markup)).toBe(true);
  return toString(markup);
}

/** The legacy capture with `id` in both selection variables, as the `cfif` branch outputs it. */
function withSelection(id: string): string {
  return LEGACY.replace(
    '\nvar currentChangesetSelection="";\nvar currentChangesetID="";\n',
    `\nvar currentChangesetSelection="${id}";\nvar currentChangesetID="${id}";\n`,
  );
}

describe('carch.edit change set dialog', () => {
  it('matches the legacy include byte for byte', () => {
    expect(render({})).toBe(LEGACY);
  });

  it.each<[string, Partial<ChangesetsDialogInput>, string]>([
    ['a pending version in its change set', { currentChangesetIsNew: false, approved: false }, CHANGESET_ID],
    ['an approved version of a stored change set', { currentChangesetIsNew: false, approved: true }, ''],
    ['an unapproved version of an unknown change set', { currentChangesetIsNew: true, approved: false }, ''],
  ])('preselects the change set for %s as legacy does', (_case, input, expected) => {
    const markup = render({ ...input, changesetId: CHANGESET_ID });
    expect(markup).toBe(withSelection(expected));
  });

  it('encodes the labels with the JavaScript and attribute encoders', () => {
    const label = `Say "hi" & <go>'`;
    const rb: RbLookup = { locale: 'en', rbKey: () => label, messageFormat: () => '' };
    const markup = render({}, rb);
    const js = 'Say\\x20\\x22hi\\x22\\x20\\x26\\x20\\x3Cgo\\x3E\\x27';
    expect(markup).toContain(`var publishitemfromchangeset="${js}"\n`);
    expect(markup).toContain(`\t\t\t\t${js}: \n`);
    expect(markup).toContain(`, text: '${js}'\n`);
    expect(markup).toContain(
      '<div style="display:none" title="Say&#x20;&quot;hi&quot;&#x20;&amp;&#x20;&lt;go&gt;&#x27;" id="changesetContainer">',
    );
  });
});
