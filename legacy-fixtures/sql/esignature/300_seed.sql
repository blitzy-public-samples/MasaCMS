-- SYNTHETIC: esignature - no Masa equivalent; legacy oracle in legacy-fixtures/
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

-- Inserts the @json ({"<table>": [rows]}) signature_request and signature rows not yet present and appends absent audit_entry rows through usp_audit_append in array order; returns one row (requests, signatures, entries).
CREATE OR ALTER PROCEDURE [synthetic].[usp_seed_esignature]
	@json [nvarchar] (max)
AS
BEGIN
	SET NOCOUNT ON; SET XACT_ABORT ON;

	DECLARE @requests [int] = 0, @signatures [int] = 0, @entries [int] = 0;

	DECLARE @entry_id [char] (35);
	DECLARE @request_id [char] (35);
	DECLARE @action [nvarchar] (30);
	DECLARE @actor_user_id [char] (35);
	DECLARE @detail [nvarchar] (max);
	DECLARE @at [datetime];

	DECLARE @appended TABLE (
		[entry_id] [char] (35) ,
		[request_id] [char] (35) ,
		[seq] [int] ,
		[action] [nvarchar] (30) ,
		[actor_user_id] [char] (35) NULL ,
		[detail] [nvarchar] (max) NULL ,
		[at] [datetime] ,
		[prev_hash] [binary] (32) ,
		[entry_hash] [binary] (32) ,
		[prev_hash_hex] [varchar] (64) ,
		[entry_hash_hex] [varchar] (64)
	);

	BEGIN TRANSACTION;

	INSERT INTO [synthetic].[signature_request] ([request_id], [siteID], [document_name], [document_sha256], [document], [signer_user_id], [state], [created], [createdByID])
	SELECT
		j.[request_id],
		j.[siteID],
		j.[document_name],
		j.[document_sha256],
		CONVERT([varbinary] (max), j.[document], 2),
		j.[signer_user_id],
		ISNULL(j.[state], N'PENDING'),
		CONVERT([datetime], j.[created], 126),
		j.[createdByID]
	FROM OPENJSON(@json, N'$.signature_request') WITH (
		[request_id] [char] (35) N'$.request_id' ,
		[siteID] [nvarchar] (25) N'$.siteID' ,
		[document_name] [nvarchar] (255) N'$.document_name' ,
		[document_sha256] [char] (64) N'$.document_sha256' ,
		[document] [nvarchar] (max) N'$.document' ,
		[signer_user_id] [char] (35) N'$.signer_user_id' ,
		[state] [nvarchar] (10) N'$.state' ,
		[created] [nvarchar] (23) N'$.created' ,
		[createdByID] [char] (35) N'$.createdByID'
	) AS j
	WHERE NOT EXISTS (SELECT 1 FROM [synthetic].[signature_request] AS r WHERE r.[request_id] = j.[request_id]);
	SET @requests = @@ROWCOUNT;

	INSERT INTO [synthetic].[signature] ([signature_id], [request_id], [typed_name], [signer_user_id], [signed_at])
	SELECT
		j.[signature_id],
		j.[request_id],
		j.[typed_name],
		j.[signer_user_id],
		CONVERT([datetime], j.[signed_at], 126)
	FROM OPENJSON(@json, N'$.signature') WITH (
		[signature_id] [char] (35) N'$.signature_id' ,
		[request_id] [char] (35) N'$.request_id' ,
		[typed_name] [nvarchar] (255) N'$.typed_name' ,
		[signer_user_id] [char] (35) N'$.signer_user_id' ,
		[signed_at] [nvarchar] (23) N'$.signed_at'
	) AS j
	WHERE NOT EXISTS (SELECT 1 FROM [synthetic].[signature] AS s WHERE s.[signature_id] = j.[signature_id]);
	SET @signatures = @@ROWCOUNT;

	DECLARE [seed_entries] CURSOR LOCAL STATIC FORWARD_ONLY READ_ONLY FOR
		SELECT e.[entry_id], e.[request_id], e.[action], e.[actor_user_id], e.[detail], CONVERT([datetime], e.[at], 126)
		FROM OPENJSON(@json, N'$.audit_entry') AS a
		CROSS APPLY OPENJSON(a.[value]) WITH (
			[entry_id] [char] (35) N'$.entry_id' ,
			[request_id] [char] (35) N'$.request_id' ,
			[action] [nvarchar] (30) N'$.action' ,
			[actor_user_id] [char] (35) N'$.actor_user_id' ,
			[detail] [nvarchar] (max) N'$.detail' ,
			[at] [nvarchar] (23) N'$.at'
		) AS e
		WHERE NOT EXISTS (SELECT 1 FROM [synthetic].[audit_entry] AS x WHERE x.[entry_id] = e.[entry_id])
		ORDER BY CAST(a.[key] AS [int]);

	OPEN [seed_entries];
	FETCH NEXT FROM [seed_entries] INTO @entry_id, @request_id, @action, @actor_user_id, @detail, @at;
	WHILE @@FETCH_STATUS = 0
	BEGIN
		INSERT INTO @appended EXEC [synthetic].[usp_audit_append] @entry_id, @request_id, @action, @actor_user_id, @detail, @at;
		FETCH NEXT FROM [seed_entries] INTO @entry_id, @request_id, @action, @actor_user_id, @detail, @at;
	END
	CLOSE [seed_entries];
	DEALLOCATE [seed_entries];

	SET @entries = (SELECT COUNT(*) FROM @appended);

	COMMIT TRANSACTION;

	SELECT @requests AS [requests], @signatures AS [signatures], @entries AS [entries];
END
GO
