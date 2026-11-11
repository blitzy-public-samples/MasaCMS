-- Heartbeat index of gateway.instance for live-instance and retention lookups.
CREATE INDEX instance_heartbeat_idx ON gateway.instance (heartbeat_at);
