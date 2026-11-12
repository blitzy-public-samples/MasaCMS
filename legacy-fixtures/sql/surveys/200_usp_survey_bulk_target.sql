-- SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

-- Adds the distinct [{siteID, groupName}] targets in @json that @survey_id lacks; returns (inserted, total).
CREATE OR ALTER PROCEDURE [synthetic].[usp_survey_bulk_target]
	@survey_id [char] (35),
	@json [nvarchar] (max),
	@now [datetime]
AS
BEGIN
	SET NOCOUNT ON;
	SET XACT_ABORT ON;

	BEGIN TRANSACTION;

	INSERT INTO [synthetic].[survey_target] ([target_id], [survey_id], [siteID], [group_name], [created])
	SELECT STUFF(CONVERT([char] (36), NEWID()), 24, 1, ''), @survey_id, [d].[siteID], [d].[groupName], @now
	FROM (
		SELECT DISTINCT [j].[siteID], [j].[groupName]
		-- Text is parsed at nvarchar(4000) because OPENJSON truncates silently; an oversized value fails on the target column instead.
		FROM OPENJSON(@json) WITH (
			[siteID] [nvarchar] (4000) '$.siteID',
			[groupName] [nvarchar] (4000) '$.groupName'
		) AS [j]
	) AS [d]
	WHERE NOT EXISTS (
		SELECT 1
		FROM [synthetic].[survey_target] AS [t] WITH (UPDLOCK, HOLDLOCK)
		WHERE [t].[survey_id] = @survey_id
			AND [t].[siteID] = [d].[siteID]
			AND ([t].[group_name] = [d].[groupName] OR ([t].[group_name] IS NULL AND [d].[groupName] IS NULL))
	);

	DECLARE @inserted [int] = @@ROWCOUNT;

	SELECT @inserted AS [inserted], COUNT(*) AS [total]
	FROM [synthetic].[survey_target]
	WHERE [survey_id] = @survey_id;

	COMMIT TRANSACTION;
END
GO
