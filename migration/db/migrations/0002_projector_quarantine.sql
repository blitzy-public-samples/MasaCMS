-- Schema migration: changes the reverse projector could not write into legacy, left out of their batches until a later change of their key repairs them

CREATE TABLE migration.projector_quarantine (
  owner text NOT NULL,
  tenant_id uuid NOT NULL,
  xid numeric(20,0) NOT NULL,
  seq bigint NOT NULL,
  legacy_table text NOT NULL,
  op text NOT NULL CHECK (op IN ('insert', 'update', 'delete')),
  legacy_key text NOT NULL,
  reason text NOT NULL,
  batch_id text NOT NULL,
  quarantined_at timestamp(3) without time zone NOT NULL,
  repaired_at timestamp(3) without time zone,
  repaired_xid numeric(20,0), -- changelog position of the change that wrote the key again
  repaired_seq bigint,
  PRIMARY KEY (owner, tenant_id, xid, seq),
  CHECK ((repaired_at IS NULL) = (repaired_xid IS NULL) AND (repaired_at IS NULL) = (repaired_seq IS NULL))
);

CREATE INDEX projector_quarantine_unrepaired_key_idx ON migration.projector_quarantine (owner, tenant_id, legacy_table, legacy_key) WHERE repaired_at IS NULL;
CREATE INDEX projector_quarantine_unrepaired_xid_idx ON migration.projector_quarantine (owner, xid) WHERE repaired_at IS NULL;
