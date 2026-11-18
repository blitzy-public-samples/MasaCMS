import { describe, expect, it } from 'vitest';
import { html, toString } from '@/lib/html';
import { opt2Screens } from '@/screens/opt2';
import { OPT2_SCREEN_TITLES, opt2View } from '@/screens/opt2/shared/view';

describe('opt2View', () => {
  it('wraps the body, marks the module and titles the screen, setting no other shell field', () => {
    const body = html`x`;
    const view = opt2View('finance', body, 'records');
    expect(view).toStrictEqual({ body, opt2Module: 'finance', moduleTitle: 'Finance Records' });
    expect(view.body).toBe(body);
    expect(toString(view.body)).toBe(toString(html`x`));
  });

  it('sets no module title for a screen without one, so the shell keeps the bare config title', () => {
    const body = html`x`;
    expect(opt2View('reporting', body, 'unregistered')).toStrictEqual({ body, opt2Module: 'reporting' });
  });
});

describe('OPT2_SCREEN_TITLES', () => {
  it.each(opt2Screens.map((def) => ({ key: `${def.module}/${def.screen}`, def })))(
    'titles registered screen $key',
    ({ def }) => {
      expect(OPT2_SCREEN_TITLES[def.module][def.screen]).toMatch(/\S/);
    },
  );

  it('titles no screen the registry does not serve', () => {
    const registered = opt2Screens.map((def) => `${def.module}/${def.screen}`).sort();
    const titled = Object.entries(OPT2_SCREEN_TITLES)
      .flatMap(([module, screens]) => Object.keys(screens).map((screen) => `${module}/${screen}`))
      .sort();
    expect(titled).toEqual(registered);
  });
});
