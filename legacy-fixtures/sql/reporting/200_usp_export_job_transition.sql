-- SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

-- Applies one legal export-job state move; returns one row (outcome: legal|illegal-state|not-found, state). Throws 50020 for done without output, file name, content type or SHA-256.
CREATE OR ALTER PROCEDURE [synthetic].[usp_export_job_transition]
	@job_id char(35), @to_state nvarchar(10), @now datetime,
	@error nvarchar(max) = NULL, @file_name nvarchar(255) = NULL,
	@content_type nvarchar(100) = NULL, @output varbinary(max) = NULL,
	@output_sha256 char(64) = NULL
AS
BEGIN
	SET NOCOUNT ON;
	SET XACT_ABORT ON;

	DECLARE @current nvarchar(10);
	DECLARE @next nvarchar(10);

	BEGIN TRANSACTION;

	SELECT @current = [state]
	FROM [synthetic].[export_job] WITH (UPDLOCK, HOLDLOCK)
	WHERE [job_id] = @job_id;

	IF @current IS NULL
	BEGIN
		COMMIT TRANSACTION;
		SELECT CAST(N'not-found' AS nvarchar(20)) AS [outcome], CAST(NULL AS nvarchar(10)) AS [state];
		RETURN;
	END

	-- Binary match keeps the stored state vocabulary exact under a case-insensitive database collation.
	SET @next = CASE
		WHEN @current = N'queued' AND @to_state COLLATE Latin1_General_BIN2 = N'running' THEN N'running'
		WHEN @current = N'running' AND @to_state COLLATE Latin1_General_BIN2 = N'done' THEN N'done'
		WHEN @current = N'running' AND @to_state COLLATE Latin1_General_BIN2 = N'failed' THEN N'failed'
	END;

	IF @next IS NULL
	BEGIN
		COMMIT TRANSACTION;
		SELECT CAST(N'illegal-state' AS nvarchar(20)) AS [outcome], @current AS [state];
		RETURN;
	END

	IF @next = N'done' AND (@output IS NULL OR @file_name IS NULL OR @content_type IS NULL OR @output_sha256 IS NULL)
		THROW 50020, N'usp_export_job_transition: done requires output', 1;

	UPDATE [synthetic].[export_job]
	SET [state] = @next,
		[started_at] = CASE WHEN @next = N'running' THEN @now ELSE [started_at] END,
		[finished_at] = CASE WHEN @next IN (N'done', N'failed') THEN @now ELSE [finished_at] END,
		[error] = CASE WHEN @next = N'failed' THEN @error ELSE [error] END,
		[file_name] = CASE WHEN @next = N'done' THEN @file_name ELSE [file_name] END,
		[content_type] = CASE WHEN @next = N'done' THEN @content_type ELSE [content_type] END,
		[output] = CASE WHEN @next = N'done' THEN @output ELSE [output] END,
		[output_sha256] = CASE WHEN @next = N'done' THEN @output_sha256 ELSE [output_sha256] END
	WHERE [job_id] = @job_id;

	COMMIT TRANSACTION;
	SELECT CAST(N'legal' AS nvarchar(20)) AS [outcome], @next AS [state];
END
GO
