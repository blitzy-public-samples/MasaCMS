-- SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

-- Inserts seed export definitions and jobs not yet present; returns (definitions, jobs).
CREATE OR ALTER PROCEDURE [synthetic].[usp_seed_reporting]
	@json nvarchar(max)
AS
BEGIN
	SET NOCOUNT ON;
	SET XACT_ABORT ON;

	DECLARE @definitions int = 0, @jobs int = 0;

	BEGIN TRANSACTION;

	INSERT INTO [synthetic].[export_definition] ([definition_id], [siteID], [name], [source], [columns])
	SELECT
		[j].[definition_id],
		[j].[siteID],
		[j].[name],
		[j].[source],
		COALESCE([j].[columns_json], [j].[columns_text])
	FROM OPENJSON(@json, N'$.export_definition') WITH (
		[definition_id] char(35) N'$.definition_id',
		[siteID] nvarchar(25) N'$.siteID',
		[name] nvarchar(100) N'$.name',
		[source] nvarchar(50) N'$.source',
		[columns_json] nvarchar(max) N'$.columns' AS JSON,
		[columns_text] nvarchar(max) N'$.columns'
	) AS [j]
	WHERE NOT EXISTS (
		SELECT 1 FROM [synthetic].[export_definition] AS [d] WHERE [d].[definition_id] = [j].[definition_id]
	);
	SET @definitions = @@ROWCOUNT;

	INSERT INTO [synthetic].[export_job] (
		[job_id], [siteID], [definition_id], [format], [state], [requested_by_id],
		[created], [started_at], [finished_at], [error], [file_name], [content_type],
		[output], [output_sha256]
	)
	SELECT
		[j].[job_id],
		[j].[siteID],
		[j].[definition_id],
		[j].[format],
		[j].[state],
		[j].[requested_by_id],
		CONVERT(datetime, [j].[created], 126),
		CONVERT(datetime, [j].[started_at], 126),
		CONVERT(datetime, [j].[finished_at], 126),
		[j].[error],
		[j].[file_name],
		[j].[content_type],
		CONVERT(varbinary(max), CONVERT(varchar(max), [j].[output]), 2),
		[j].[output_sha256]
	FROM OPENJSON(@json, N'$.export_job') WITH (
		[job_id] char(35) N'$.job_id',
		[siteID] nvarchar(25) N'$.siteID',
		[definition_id] char(35) N'$.definition_id',
		[format] nvarchar(4) N'$.format',
		[state] nvarchar(10) N'$.state',
		[requested_by_id] char(35) N'$.requested_by_id',
		[created] nvarchar(23) N'$.created',
		[started_at] nvarchar(23) N'$.started_at',
		[finished_at] nvarchar(23) N'$.finished_at',
		[error] nvarchar(max) N'$.error',
		[file_name] nvarchar(255) N'$.file_name',
		[content_type] nvarchar(100) N'$.content_type',
		[output] nvarchar(max) N'$.output',
		[output_sha256] char(64) N'$.output_sha256'
	) AS [j]
	WHERE NOT EXISTS (
		SELECT 1 FROM [synthetic].[export_job] AS [x] WHERE [x].[job_id] = [j].[job_id]
	);
	SET @jobs = @@ROWCOUNT;

	COMMIT;

	SELECT @definitions AS [definitions], @jobs AS [jobs];
END
GO
