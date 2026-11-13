// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { Role } from '@opt2/platform/auth';
import type { Opt2ActionDefinition, Opt2ScreenDefinition } from '../../registry';
import { opt2Gate } from '../shared';
import { auditScreen } from './audit';
import {
  ESIGNATURE,
  READER_ROLES,
  REQUEST_SCREEN,
  SIGN_ACTION,
  SIGNER_ROLES,
  VERIFY_ACTION,
  VERIFY_SCREEN,
} from './common';
import { loadRequest, renderRequest, type RequestData } from './request';
import { requestsScreen } from './requests';
import { submitSign } from './sign';
import { loadVerify, renderVerify, type VerifyData } from './verify';
import { submitVerifyCopy } from './verify-copy';

/** Module, owning service, the contract roles of the operation behind a definition and their deny-by-default gate. */
function access(roles: readonly Role[]) {
  return { module: ESIGNATURE, service: ESIGNATURE, roles, gate: opt2Gate(roles) } as const;
}

const requestScreen: Opt2ScreenDefinition<RequestData> = Object.freeze({
  ...access(READER_ROLES),
  screen: REQUEST_SCREEN,
  load: loadRequest,
  render: renderRequest,
});

const verifyScreen: Opt2ScreenDefinition<VerifyData> = Object.freeze({
  ...access(READER_ROLES),
  screen: VERIFY_SCREEN,
  load: loadVerify,
  render: renderVerify,
});

const signAction: Opt2ActionDefinition = Object.freeze({
  ...access(SIGNER_ROLES),
  action: SIGN_ACTION,
  submit: submitSign,
});

const verifyAction: Opt2ActionDefinition = Object.freeze({
  ...access(READER_ROLES),
  action: VERIFY_ACTION,
  submit: submitVerifyCopy,
});

/** The e-signature screens: the OPT-2 nav landing, the signing request, its audit chain and verification. */
export const esignatureScreens: readonly Opt2ScreenDefinition[] = Object.freeze([
  requestsScreen,
  requestScreen,
  auditScreen,
  verifyScreen,
]);

/** The e-signature post actions: the typed-name signature and the verification of a supplied chain copy. */
export const esignatureActions: readonly Opt2ActionDefinition[] = Object.freeze([signAction, verifyAction]);
