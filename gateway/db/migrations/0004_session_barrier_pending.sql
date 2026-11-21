-- Target writes declared before forwarding and not yet recorded, whose owners a session's legacy reads await.
ALTER TABLE gateway.session_barrier
  ALTER COLUMN xid DROP NOT NULL,
  ADD COLUMN pending integer NOT NULL DEFAULT 0 CHECK (pending >= 0);
