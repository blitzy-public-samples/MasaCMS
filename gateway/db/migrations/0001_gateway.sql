-- Schema gateway: cut-over, session-mapping and barrier coordination state; it holds no tenant data, so no RLS.

-- Active cut-over version and epoch (single row).
CREATE TABLE gateway.cutover_state (
  id smallint NOT NULL DEFAULT 1,
  table_version text NULL,
  previous_version text NULL,
  epoch bigint NOT NULL DEFAULT 0,
  activated_at timestamp(3) without time zone NULL,
  activated_by text NULL,
  PRIMARY KEY (id),
  CHECK (id = 1)
);

-- Frozen route keys and the epoch of each freeze.
CREATE TABLE gateway.cutover_freeze (
  route text NOT NULL,
  epoch bigint NOT NULL,
  frozen_at timestamp(3) without time zone NOT NULL,
  frozen_by text NOT NULL,
  PRIMARY KEY (route)
);

-- Heartbeat and last seen epoch of each gateway instance.
CREATE TABLE gateway.instance (
  instance_id text NOT NULL,
  seen_epoch bigint NOT NULL,
  started_at timestamp(3) without time zone NOT NULL,
  heartbeat_at timestamp(3) without time zone NOT NULL,
  PRIMARY KEY (instance_id)
);

-- Forwarded writes not yet completed, per instance.
CREATE TABLE gateway.inflight (
  instance_id text NOT NULL,
  request_id text NOT NULL,
  route text NOT NULL,
  side text NOT NULL,
  window_id text NULL,
  started_at timestamp(3) without time zone NOT NULL,
  PRIMARY KEY (instance_id, request_id),
  CHECK (side IN ('legacy', 'target'))
);
CREATE INDEX inflight_side_route_idx ON gateway.inflight (side, route);

-- Legacy ColdFusion cookies and session mode per identity session.
CREATE TABLE gateway.legacy_jar (
  session_id text NOT NULL,
  legacy_session_id text NULL,
  cookies jsonb NOT NULL,
  mode text NOT NULL,
  hydrated_epoch bigint NULL,
  updated_at timestamp(3) without time zone NOT NULL,
  PRIMARY KEY (session_id),
  CHECK (mode IN ('legacy-primary', 'target-primary'))
);
CREATE UNIQUE INDEX legacy_jar_legacy_session_uidx ON gateway.legacy_jar (legacy_session_id) WHERE legacy_session_id IS NOT NULL;

-- Highest recorded write position per session and owning service.
CREATE TABLE gateway.session_barrier (
  session_id text NOT NULL,
  owner text NOT NULL,
  xid numeric(20,0) NOT NULL,
  recorded_at timestamp(3) without time zone NOT NULL,
  PRIMARY KEY (session_id, owner)
);

INSERT INTO gateway.cutover_state (id, table_version, previous_version, epoch, activated_at, activated_by) VALUES (1, NULL, NULL, 0, NULL, NULL);
