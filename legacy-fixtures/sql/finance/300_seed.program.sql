-- SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON;
GO

-- Inserts @json seed finance rows absent by primary key; returns one row of inserted counts (records, versions, attachments).
CREATE OR ALTER PROCEDURE [$(PROGRAM_SCHEMA)].[usp_seed_finance] @json nvarchar(max) AS
BEGIN
	SET NOCOUNT ON; SET XACT_ABORT ON;

	DECLARE @records int = 0, @versions int = 0, @attachments int = 0;

	BEGIN TRANSACTION;

	INSERT INTO [$(PROGRAM_SCHEMA)].[finance_record] (
		[record_id], [siteID], [title], [amount], [period], [state], [version],
		[created], [createdByID], [lastUpdate], [lastUpdateByID]
	)
	SELECT
		j.[record_id],
		j.[siteID],
		j.[title],
		CONVERT(numeric(19, 4), j.[amount]),
		j.[period],
		j.[state],
		j.[version],
		CONVERT(datetime, j.[created], 126),
		j.[createdByID],
		CONVERT(datetime, j.[lastUpdate], 126),
		j.[lastUpdateByID]
	FROM OPENJSON(@json, N'$.finance_record') WITH (
		[record_id] char(35) N'$.record_id',
		[siteID] nvarchar(25) N'$.siteID',
		[title] nvarchar(255) N'$.title',
		[amount] nvarchar(40) N'$.amount',
		[period] nvarchar(7) N'$.period',
		[state] nvarchar(20) N'$.state',
		[version] int N'$.version',
		[created] nvarchar(23) N'$.created',
		[createdByID] char(35) N'$.createdByID',
		[lastUpdate] nvarchar(23) N'$.lastUpdate',
		[lastUpdateByID] char(35) N'$.lastUpdateByID'
	) AS j
	WHERE NOT EXISTS (SELECT 1 FROM [$(PROGRAM_SCHEMA)].[finance_record] t WHERE t.[record_id] = j.[record_id]);
	SET @records = @@ROWCOUNT;

	INSERT INTO [$(PROGRAM_SCHEMA)].[finance_record_version] (
		[version_id], [record_id], [version], [state], [title], [amount], [period],
		[action], [actor_user_id], [created]
	)
	SELECT
		j.[version_id],
		j.[record_id],
		j.[version],
		j.[state],
		j.[title],
		CONVERT(numeric(19, 4), j.[amount]),
		j.[period],
		j.[action],
		j.[actor_user_id],
		CONVERT(datetime, j.[created], 126)
	FROM OPENJSON(@json, N'$.finance_record_version') WITH (
		[version_id] char(35) N'$.version_id',
		[record_id] char(35) N'$.record_id',
		[version] int N'$.version',
		[state] nvarchar(20) N'$.state',
		[title] nvarchar(255) N'$.title',
		[amount] nvarchar(40) N'$.amount',
		[period] nvarchar(7) N'$.period',
		[action] nvarchar(30) N'$.action',
		[actor_user_id] char(35) N'$.actor_user_id',
		[created] nvarchar(23) N'$.created'
	) AS j
	WHERE NOT EXISTS (SELECT 1 FROM [$(PROGRAM_SCHEMA)].[finance_record_version] t WHERE t.[version_id] = j.[version_id]);
	SET @versions = @@ROWCOUNT;

	INSERT INTO [$(PROGRAM_SCHEMA)].[finance_attachment] (
		[attachment_id], [record_id], [file_name], [content_type], [size_bytes], [sha256],
		[content], [created], [createdByID]
	)
	SELECT
		j.[attachment_id],
		j.[record_id],
		j.[file_name],
		j.[content_type],
		j.[size_bytes],
		j.[sha256],
		CONVERT(varbinary(max), j.[content], 2),
		CONVERT(datetime, j.[created], 126),
		j.[createdByID]
	FROM OPENJSON(@json, N'$.finance_attachment') WITH (
		[attachment_id] char(35) N'$.attachment_id',
		[record_id] char(35) N'$.record_id',
		[file_name] nvarchar(255) N'$.file_name',
		[content_type] nvarchar(100) N'$.content_type',
		[size_bytes] int N'$.size_bytes',
		[sha256] char(64) N'$.sha256',
		[content] nvarchar(max) N'$.content',
		[created] nvarchar(23) N'$.created',
		[createdByID] char(35) N'$.createdByID'
	) AS j
	WHERE NOT EXISTS (SELECT 1 FROM [$(PROGRAM_SCHEMA)].[finance_attachment] t WHERE t.[attachment_id] = j.[attachment_id]);
	SET @attachments = @@ROWCOUNT;

	COMMIT TRANSACTION;

	SELECT @records AS [records], @versions AS [versions], @attachments AS [attachments];
END
GO
