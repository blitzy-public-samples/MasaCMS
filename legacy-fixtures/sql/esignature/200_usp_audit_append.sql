-- SYNTHETIC: esignature - no Masa equivalent; legacy oracle in legacy-fixtures/
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

-- Appends one hash-chained audit entry to a request; returns the stored row plus lowercase-hex prev_hash_hex and entry_hash_hex.
CREATE OR ALTER PROCEDURE [synthetic].[usp_audit_append]
	@entry_id char(35),
	@request_id char(35),
	@action nvarchar(30),
	@actor_user_id char(35),
	@detail nvarchar(max),
	@at datetime
AS
BEGIN
	SET NOCOUNT ON; SET XACT_ABORT ON;

	DECLARE @last_seq int;
	DECLARE @last_hash binary(32);
	DECLARE @seq int;
	DECLARE @prev_hash binary(32);
	DECLARE @canonical nvarchar(max);
	DECLARE @entry_hash binary(32);

	BEGIN TRANSACTION;

	SELECT TOP (1) @last_seq = [seq], @last_hash = [entry_hash]
	FROM [synthetic].[audit_entry] WITH (UPDLOCK, HOLDLOCK)
	WHERE [request_id] = @request_id
	ORDER BY [seq] DESC;

	SET @seq = ISNULL(@last_seq, 0) + 1;
	SET @prev_hash = ISNULL(@last_hash, CAST(REPLICATE(0x00, 32) AS binary(32)));

	-- COALESCE, not ISNULL: ISNULL would type N'' as char(35) and pad a NULL actor to 35 spaces.
	SET @canonical = CONCAT(@request_id, N'|', @seq, N'|', @action, N'|', COALESCE(@actor_user_id, N''), N'|', COALESCE(@detail, N''), N'|', FORMAT(@at, 'yyyy-MM-dd''T''HH:mm:ss.fff', 'en-US'));

	SET @entry_hash = HASHBYTES('SHA2_256', @prev_hash + CAST(@canonical AS varbinary(max)));

	SET @entry_id = ISNULL(@entry_id, STUFF(CONVERT(char(36), NEWID()), 24, 1, ''));

	INSERT INTO [synthetic].[audit_entry] ([entry_id], [request_id], [seq], [action], [actor_user_id], [detail], [at], [prev_hash], [entry_hash])
	VALUES (@entry_id, @request_id, @seq, @action, @actor_user_id, @detail, @at, @prev_hash, @entry_hash);

	COMMIT TRANSACTION;

	SELECT [entry_id], [request_id], [seq], [action], [actor_user_id], [detail], [at], [prev_hash], [entry_hash],
		LOWER(CONVERT(varchar(64), [prev_hash], 2)) AS [prev_hash_hex],
		LOWER(CONVERT(varchar(64), [entry_hash], 2)) AS [entry_hash_hex]
	FROM [synthetic].[audit_entry]
	WHERE [entry_id] = @entry_id;
END
GO
