/** Service routes people drives the roster write protocol's account operations through: prepare, commit, abort, finish, revert and the status read. */
import { AuthDenial, serviceRole, type Opt2AuthContext, type Opt2RouteConfig, type UserClaims } from '@opt2/platform/auth';
import type { FastifyInstance, FastifyReply } from '@opt2/platform/service-kit';
import {
  abortAccountOperation,
  accountOperationStatus,
  commitAccountOperation,
  finishAccountOperation,
  prepareAccountOperation,
  revertAccountOperation,
  type AccountChange,
  type AccountOperationDeps,
  type AccountOperationView,
  type StepInput,
  type StepOutcome,
} from '../domain/account-operations.js';
import type { components, operations } from '../generated/openapi.js';

type Schemas = components['schemas'];
type OperationParams = operations['getAccountOperation']['parameters']['path'];
type PrepareBody = Schemas['AccountPrepareRequest'];

/** The account operations the routes delegate to. */
export type AccountRouteDeps = { accounts: AccountOperationDeps };

type StepAction = 'abort' | 'finish' | 'revert';
type Step = (deps: AccountOperationDeps, operationId: string, input?: StepInput) => Promise<StepOutcome>;

const STEPS: Readonly<Record<StepAction, Step>> = Object.freeze({
  abort: abortAccountOperation,
  finish: finishAccountOperation,
  revert: revertAccountOperation,
});

const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;

const ROUTE_AUTH: Opt2RouteConfig = Object.freeze({ transport: 'service', requires: Object.freeze([serviceRole('people')]) });

// Prepare's `siteId` is the account's user pool site, which may be a pool other than the token's site; the domain
// accepts it only when it is the pool the tenant registry gives the token's site, so the generic `siteid` check is off.
const PREPARE_AUTH: Opt2RouteConfig = Object.freeze({ ...ROUTE_AUTH, siteCheck: false });

const OPERATION_URL = '/internal/v1/accounts/:userId/operations/:operationId';

const CF_UUID = {
  type: 'string',
  minLength: 35,
  maxLength: 35,
  pattern: '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{16}$',
} as const;

const INTEGER = { type: 'integer' } as const;
const TEXT = { type: 'string' } as const;

// UserId, OperationId and AccountPrepareRequest as the contract declares them; Fastify validates them once, before the handler.
const OPERATION_PARAMS = {
  type: 'object',
  required: ['userId', 'operationId'],
  properties: { userId: CF_UUID, operationId: CF_UUID },
} as const;

const PREPARE_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'siteId', 'account', 'groupIds'],
  properties: {
    kind: { type: 'string', enum: ['create', 'update'] },
    siteId: { type: 'string', minLength: 1 },
    account: {
      type: 'object',
      additionalProperties: false,
      required: ['UserName', 'Perm', 'InActive', 'isPublic', 'Admin', 'remoteID', 'Type'],
      properties: {
        UserName: TEXT,
        Password: TEXT,
        S2: { type: 'integer', enum: [0, 1] },
        Perm: INTEGER,
        InActive: INTEGER,
        isPublic: INTEGER,
        Admin: INTEGER,
        remoteID: TEXT,
        Type: { type: 'integer', const: 2 },
      },
    },
    groupIds: { type: 'array', items: CF_UUID },
  },
} as const;

/** The route of the contract's `{operationId}:<action>` path. */
function actionUrl(action: string): string {
  // The router ends a parameter name only at `(`, `-`, `.` or `/`, so `:operationId::prepare` would declare `operationId::prepare`;
  // the `(.+)` pattern ends the name at `operationId`, and `::` is the literal colon of the contract's `{operationId}:prepare`.
  return `${OPERATION_URL}(.+)::${action}`;
}

/** The verified user claims; prepare applies the token site's user pools and the actor's S2 rule, so their absence is a missing credential. */
function userOf(auth: Opt2AuthContext): UserClaims {
  if (auth.user === undefined) throw AuthDenial.unauthenticated('missing-credential');
  return auth.user;
}

/** The domain change of a prepare body; `Admin` and `Type` stay out because `userDAO` never writes `Admin` and a roster user is always Type 2. */
function changeOf({ account, groupIds }: PrepareBody): AccountChange {
  return {
    username: account.UserName,
    // An absent password leaves an update's credential as stored and gives a create a random one.
    password: account.Password ?? '',
    s2: account.S2 ?? 0,
    perm: account.Perm,
    inActive: account.InActive,
    isPublic: account.isPublic,
    remoteID: account.remoteID,
    groupIds,
  };
}

/** Answers 409 with the operation whose recorded state refuses the step. */
function sendConflict(reply: FastifyReply, operation: AccountOperationView): FastifyReply {
  return reply.code(HTTP_CONFLICT).send(operation);
}

/** Registers the status read and the five operation steps; only people's invocation credential is accepted. */
export async function registerAccountRoutes(app: FastifyInstance, deps: AccountRouteDeps): Promise<void> {
  const { accounts } = deps;

  // The contract has no not-found answer here: an operation identity never recorded reads as `unknown`.
  app.get<{ Params: OperationParams; Reply: AccountOperationView }>(
    OPERATION_URL,
    { schema: { params: OPERATION_PARAMS }, config: { opt2: ROUTE_AUTH } },
    async (request) => accountOperationStatus(accounts, request.params.operationId, { userId: request.params.userId }),
  );

  app.post<{ Params: OperationParams; Body: PrepareBody }>(
    actionUrl('prepare'),
    { schema: { params: OPERATION_PARAMS, body: PREPARE_BODY }, config: { opt2: PREPARE_AUTH } },
    async (request, reply) => {
      const user = userOf(request.opt2Auth);
      const { userId, operationId } = request.params;
      const { kind, siteId } = request.body;
      const result = await prepareAccountOperation(accounts, {
        operationId,
        kind,
        userId,
        requestSiteId: user.site,
        siteId,
        actorIsSuperUser: user.s2,
        change: changeOf(request.body),
      });
      if (result.outcome === 'invalid') return reply.code(HTTP_BAD_REQUEST).send(result.errors);
      if (result.outcome === 'conflict') return sendConflict(reply, result.operation);
      return reply.send(result.operation);
    },
  );

  app.post<{ Params: OperationParams }>(
    actionUrl('commit'),
    { schema: { params: OPERATION_PARAMS }, config: { opt2: ROUTE_AUTH } },
    async (request, reply) => {
      const outcome = await commitAccountOperation(accounts, request.params.operationId, { userId: request.params.userId });
      return outcome.outcome === 'committed' ? reply.send(outcome.result) : sendConflict(reply, outcome.operation);
    },
  );

  for (const [action, step] of Object.entries(STEPS) as Array<[StepAction, Step]>) {
    app.post<{ Params: OperationParams }>(
      actionUrl(action),
      { schema: { params: OPERATION_PARAMS }, config: { opt2: ROUTE_AUTH } },
      async (request, reply) => {
        const outcome = await step(accounts, request.params.operationId, { userId: request.params.userId });
        return outcome.outcome === 'stepped' ? reply.send(outcome.step) : sendConflict(reply, outcome.operation);
      },
    );
  }
}
