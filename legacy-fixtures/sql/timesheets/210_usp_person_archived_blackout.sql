-- SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

-- Blacks out an archived person's open days in each program whose site is @siteID or pools its users there; returns (program_id, blackouts) per program.
CREATE OR ALTER PROCEDURE [synthetic].[usp_person_archived_blackout]
	@person_id char(35),
	@siteID nvarchar(50),
	@effective_from datetime,
	@archive_id char(35),
	@now datetime
AS
BEGIN
	SET NOCOUNT ON; SET XACT_ABORT ON;

	DECLARE @destinations TABLE ([program_id] int NOT NULL PRIMARY KEY);
	DECLARE @results TABLE ([program_id] int NOT NULL PRIMARY KEY, [blackouts] int NOT NULL);
	DECLARE @program_id int;
	DECLARE @proc nvarchar(300);
	DECLARE @stmt nvarchar(max);
	DECLARE @blackouts int;

	-- An empty or NULL user pool means the site's own id, as in Masa's settingsBean.
	INSERT INTO @destinations ([program_id])
	SELECT DISTINCT [ps].[program_id]
	FROM [synthetic].[program_site] AS [ps]
	WHERE [ps].[siteID] = @siteID
		OR EXISTS (
			SELECT 1 FROM [dbo].[tsettings] AS [s]
			WHERE [s].[SiteID] = [ps].[siteID]
				AND (COALESCE(NULLIF([s].[publicUserPoolID], N''), [s].[SiteID]) = @siteID
					OR COALESCE(NULLIF([s].[privateUserPoolID], N''), [s].[SiteID]) = @siteID)
		);

	BEGIN TRANSACTION;

	SELECT @program_id = MIN([program_id]) FROM @destinations;

	WHILE @program_id IS NOT NULL
	BEGIN
		SET @proc = QUOTENAME(N'Program_' + CONVERT(nvarchar(10), @program_id)) + N'.[usp_apply_blackout]';
		IF OBJECT_ID(@proc, N'P') IS NULL
			THROW 50011, N'usp_apply_blackout missing for program', 1;

		SET @stmt = N'EXEC ' + @proc + N' @person_id, @effective_from, @archive_id, @now, @blackouts OUTPUT';
		SET @blackouts = NULL;
		EXEC sp_executesql @stmt,
			N'@person_id char(35), @effective_from datetime, @archive_id char(35), @now datetime, @blackouts int OUTPUT',
			@person_id = @person_id, @effective_from = @effective_from, @archive_id = @archive_id, @now = @now, @blackouts = @blackouts OUTPUT;

		INSERT INTO @results ([program_id], [blackouts]) VALUES (@program_id, @blackouts);

		SELECT @program_id = MIN([program_id]) FROM @destinations WHERE [program_id] > @program_id;
	END

	COMMIT TRANSACTION;

	SELECT [program_id], [blackouts] FROM @results ORDER BY [program_id];
END
GO
