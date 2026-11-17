-- Set when the forwarding instance ended a target exchange not knowing whether its write committed; the row stays until evidence clears it.
ALTER TABLE gateway.inflight ADD COLUMN abandoned_at timestamp(3) without time zone NULL;
