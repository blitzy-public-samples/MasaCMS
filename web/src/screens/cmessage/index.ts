// The reproduced `cmessage` circuit for the screen registry (server-only).
import type { PageScreen, ScreenDefinition } from '../registry';
import { noaccessGate, renderNoaccess } from './noaccess';

const noaccessScreen: PageScreen<undefined> = Object.freeze({
  circuit: 'cmessage',
  action: 'noaccess',
  owner: 'identity',
  mode: 'page',
  gate: noaccessGate,
  render: () => renderNoaccess(),
});

/** The circuit's one action, the view-only `cMessage.noaccess` page. */
export const cmessageScreens: readonly ScreenDefinition[] = Object.freeze([noaccessScreen]);
