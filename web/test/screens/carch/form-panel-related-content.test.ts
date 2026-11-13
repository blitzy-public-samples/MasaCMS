import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isSafeHtml, toString } from '@/lib/html';
import { rbFor, type RbLookup } from '@/lib/resource-bundles/rb';
import { renderPanelRelatedContent } from '@/screens/carch/form/panel-related-content';

// `cArch.edit` of Home on the default site, captured from the legacy ACF 2023 server as admin and cut from the
// include's leading newline through `</script>\n\n`.
const LEGACY = readFileSync(
  new URL('../../fixtures/strategies-content/edit-panel-related-content.html', import.meta.url),
  'utf8',
);

describe('carch.edit related content panel', () => {
  it('matches the legacy include byte for byte and names its tab', () => {
    const panel = renderPanelRelatedContent({ ctx: { rb: rbFor('en') } });
    expect(isSafeHtml(panel.html)).toBe(true);
    expect(toString(panel.html)).toBe(LEGACY);
    expect(panel).toMatchObject({ tabId: 'tabRelatedcontent', tabLabel: 'Related Content' });
    expect(panel.bodyContent).toBeUndefined();
    expect(panel.htmlHead).toBeUndefined();
  });

  it('prints the heading label unencoded and the flyout title attribute-encoded, as legacy does', () => {
    const label = `Say "hi" & <go>'`;
    const rb: RbLookup = { locale: 'en', rbKey: () => label, messageFormat: () => '' };
    const panel = renderPanelRelatedContent({ ctx: { rb } });
    const markup = toString(panel.html);
    expect(markup).toContain(`aria-controls="panel-relatedcontent">${label}</a>`);
    expect(markup).toContain(
      '<div class="bigui__title">Say&#x20;&quot;hi&quot;&#x20;&amp;&#x20;&lt;go&gt;&#x27;</div>',
    );
    expect(panel.tabLabel).toBe(label);
  });
});
