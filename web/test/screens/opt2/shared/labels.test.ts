// SYNTHETIC: opt2-admin - no Masa equivalent; legacy oracle in legacy-fixtures/
import { describe, expect, it } from 'vitest';
import { isSafeHtml, toString, type SafeHtml } from '@/lib/html';
import { rbFor } from '@/lib/resource-bundles/rb';
import { bundleLabel, opt2Label, OPT2_LABEL_KEYS, type Opt2LabelName } from '@/screens/opt2/shared/labels';

const NAMES = Object.keys(OPT2_LABEL_KEYS) as Opt2LabelName[];

describe('opt2 labels', () => {
  it('freezes the catalogue', () => {
    expect(Object.isFrozen(OPT2_LABEL_KEYS)).toBe(true);
  });

  it.each(NAMES)('resolves %s in en_US to its exact English wording', (name) => {
    const label = opt2Label({ rb: rbFor('en_US') }, name);
    expect(isSafeHtml(label)).toBe(true);
    expect(toString(label)).toBe(name);
  });

  it.each<[string, Opt2LabelName, string]>([
    ['fr', 'Created', 'Créé'],
    ['fr', 'Save', 'Enregistrer'],
    ['fr', 'Approve', 'Valider'],
    ['fr', 'Subject', 'Sujet'],
    ['de', 'Created', 'Erstellt'],
    ['de', 'Save', 'Speichern'],
    ['de', 'Approve', 'Bestätigen'],
  ])('resolves in %s %s as %s', (locale, name, expected) => {
    expect(toString(opt2Label({ rb: rbFor(locale) }, name))).toBe(expected);
  });

  it.each<[string, () => SafeHtml, string]>([
    ['a de bundle key', () => bundleLabel(rbFor('de'), 'user.prev'), 'Zur&uuml;ck'],
    ['a hu catalogue label', () => opt2Label({ rb: rbFor('hu') }, 'Next'), 'Következ&#337;'],
  ])('emits the HTML entity of %s unencoded', (_, render, expected) => {
    expect(toString(render())).toBe(expected);
  });
});
