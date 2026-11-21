// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { components, operations } from '@/generated/clients/e-signature';
import { TENANT_A } from '@opt2/platform/testing';
import { USER_IDS } from '../session';
import type { FakeRouteTable } from '../../helpers/fake-gateway';

type S = components['schemas'];
type SignAnswer = operations['signRequest']['responses'][200]['content']['application/json'];
type SignConflict = operations['signRequest']['responses'][409]['content']['application/json;charset=utf-8'];

export const ESIGNATURE_IDS = Object.freeze({
  signedRequest: 'E5160001-0000-0000-0000000000000001',
  pendingRequest: 'E5160001-0000-0000-0000000000000002',
  signature: 'E5160002-0000-0000-0000000000000001',
  createdEntry: 'E5160003-0000-0000-0000000000000001',
  signedEntry: 'E5160003-0000-0000-0000000000000002',
  signer: 'E51600F0-0000-0000-0000000000000001',
} as const);

const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';
const SIGNED_DOCUMENT_SHA256 = 'a049f1c1c0daa458e64b981eb0473ad5fc47c20aa8386aca60b76c6b9f0d1f7f';
const PENDING_DOCUMENT_SHA256 = 'a84c897a7e48db8d14ee4cd0e81b1b16880196905975d48166ea9a63de84f21f';
const CREATED_ENTRY_HASH = 'a63b0bd3068273b22c735ec1320165c19472e87887d7dca1b23f305f2798df03';
const SIGNED_ENTRY_HASH = '5a1f5241b50f0957ab069accfeeb9b172584c7370f9a7fdd327a8f4b5cc877fa';

export const signedRequest: S['SignatureRequest'] = {
  request_id: ESIGNATURE_IDS.signedRequest,
  siteid: TENANT_A.siteId,
  document_name: 'tenant-a-supplier-agreement.pdf',
  document_sha256: SIGNED_DOCUMENT_SHA256,
  signer_user_id: ESIGNATURE_IDS.signer,
  state: 'SIGNED',
  created: '2026-06-28T10:00:00',
  createdbyid: USER_IDS.tenantASiteAdmin,
};

export const pendingRequest: S['SignatureRequest'] = {
  request_id: ESIGNATURE_IDS.pendingRequest,
  siteid: TENANT_A.siteId,
  document_name: 'tenant-a-data-processing-addendum.pdf',
  document_sha256: PENDING_DOCUMENT_SHA256,
  signer_user_id: ESIGNATURE_IDS.signer,
  state: 'PENDING',
  created: '2026-06-29T14:30:00',
  createdbyid: USER_IDS.tenantASiteAdmin,
};

export const signatureRequestList: S['SignatureRequestList'] = {
  items: [signedRequest, pendingRequest],
  startindex: 1,
  endindex: 2,
  itemsperpage: 50,
  totalitems: 2,
  totalpages: 1,
  pageindex: 1,
};

export const signature: S['Signature'] = {
  signature_id: ESIGNATURE_IDS.signature,
  request_id: ESIGNATURE_IDS.signedRequest,
  typed_name: 'Jordan Ellis',
  signer_user_id: ESIGNATURE_IDS.signer,
  signed_at: '2026-06-30T09:15:00',
};

export const signedRequestDetail: S['SignatureRequestDetail'] = { ...signedRequest, signature };

export const pendingRequestDetail: S['SignatureRequestDetail'] = { ...pendingRequest, signature: null };

// The contract's AuditAction is only created|signed and a request signs once, so a signed chain ends at seq 2.
export const auditChain: S['AuditChain'] = {
  items: [
    {
      entry_id: ESIGNATURE_IDS.createdEntry,
      request_id: ESIGNATURE_IDS.signedRequest,
      seq: 1,
      action: 'created',
      actor_user_id: USER_IDS.tenantASiteAdmin,
      detail: SIGNED_DOCUMENT_SHA256,
      at: '2026-06-28T10:00:00.000',
      prev_hash: GENESIS_HASH,
      entry_hash: CREATED_ENTRY_HASH,
    },
    {
      entry_id: ESIGNATURE_IDS.signedEntry,
      request_id: ESIGNATURE_IDS.signedRequest,
      seq: 2,
      action: 'signed',
      actor_user_id: ESIGNATURE_IDS.signer,
      detail: 'Jordan Ellis',
      at: '2026-06-30T09:15:00.000',
      prev_hash: CREATED_ENTRY_HASH,
      entry_hash: SIGNED_ENTRY_HASH,
    },
  ],
  startindex: 1,
  endindex: 2,
  itemsperpage: 50,
  totalitems: 2,
  totalpages: 1,
  pageindex: 1,
};

export const verifyValid: S['VerifyResult'] = { valid: true, entries: 2, brokenat: 0 };

export const verifyTampered: S['VerifyResult'] = { valid: false, entries: 2, brokenat: 2 };

export const signLegacyAnswer: SignAnswer = { ...pendingRequest, state: 'SIGNED' };

export const signAlreadySigned: { readonly status: 409; readonly body: SignConflict } = {
  status: 409,
  body: {
    apiversion: 'v1',
    method: 'esignature.requests.sign',
    error: { code: 'invalid_request', message: 'already-signed' },
  },
};

const REQUESTS = '/opt2/svc/e-signature/v1/esignature/requests';
const SIGNED = `${REQUESTS}/${ESIGNATURE_IDS.signedRequest}`;
const PENDING = `${REQUESTS}/${ESIGNATURE_IDS.pendingRequest}`;

export const eSignatureAnswers = Object.freeze({
  [`GET ${REQUESTS}`]: { status: 200, body: signatureRequestList },
  [`POST ${REQUESTS}`]: { status: 200, body: pendingRequest },
  [`GET ${SIGNED}`]: { status: 200, body: signedRequestDetail },
  [`GET ${PENDING}`]: { status: 200, body: pendingRequestDetail },
  [`GET ${SIGNED}/audit`]: { status: 200, body: auditChain },
  [`GET ${SIGNED}/verify`]: { status: 200, body: verifyValid },
  [`POST ${SIGNED}/verify`]: { status: 200, body: verifyTampered },
  [`POST ${PENDING}/sign`]: { status: 200, body: signLegacyAnswer },
  [`POST ${SIGNED}/sign`]: signAlreadySigned,
} satisfies FakeRouteTable);
