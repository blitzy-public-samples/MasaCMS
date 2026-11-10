-- opt2_sync: reverse-projector checkpoint
IF SCHEMA_ID(N'opt2_sync') IS NULL EXEC(N'CREATE SCHEMA opt2_sync');

IF OBJECT_ID(N'opt2_sync.projector_checkpoint', N'U') IS NULL CREATE TABLE opt2_sync.projector_checkpoint (
	owner nvarchar(64) NOT NULL,
	tenant_id char(36) NOT NULL,
	cursor_xid decimal(20,0) NOT NULL,
	cursor_seq bigint NOT NULL,
	applied_horizon decimal(20,0) NOT NULL,
	batch_id nvarchar(64) NOT NULL,
	rows_applied int NOT NULL,
	updated_at datetime2(3) NOT NULL,
	CONSTRAINT PK_opt2_sync_projector_checkpoint PRIMARY KEY (owner, tenant_id)
);
