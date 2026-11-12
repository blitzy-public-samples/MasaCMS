import { describe, expect, it } from 'vitest';
import { html, toString } from '@/lib/html';
import { opt2View } from '@/screens/opt2/shared/view';

describe('opt2View', () => {
  it('wraps the body and marks the module, setting no other shell field', () => {
    const body = html`x`;
    const view = opt2View('finance', body);
    expect(view).toStrictEqual({ body, opt2Module: 'finance' });
    expect(view.body).toBe(body);
    expect(toString(view.body)).toBe(toString(html`x`));
  });
});
