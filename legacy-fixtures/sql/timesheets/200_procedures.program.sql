-- SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

-- Status, overdue flag and day counts of every timesheet as of @asOf; blackout days count only in day_count and blackout_count.
CREATE OR ALTER FUNCTION [$(PROGRAM_SCHEMA)].[tvf_timesheet_status] (@asOf datetime)
RETURNS TABLE
AS
RETURN (
	SELECT [t].[timesheet_id], [t].[siteID], [t].[person_id], [t].[period_start],
		CAST(CASE
			WHEN [c].[n] = 0 THEN N'DRAFT'
			WHEN [c].[returned] > 0 THEN N'RETURNED'
			WHEN [c].[approved] = [c].[n] THEN N'APPROVED'
			WHEN [c].[approved] > 0 THEN N'PARTIALLY_APPROVED'
			WHEN [c].[submitted_or_later] = [c].[n] THEN N'SUBMITTED'
			ELSE N'DRAFT'
		END AS nvarchar(20)) AS [status],
		CAST(CASE WHEN [t].[due_date] < @asOf AND [c].[draft] > 0 THEN 1 ELSE 0 END AS tinyint) AS [overdue],
		ISNULL([c].[day_count], 0) AS [day_count],
		ISNULL([c].[blackout_count], 0) AS [blackout_count],
		ISNULL([c].[approved], 0) AS [approved_count]
	FROM [$(PROGRAM_SCHEMA)].[timesheet] AS [t]
	OUTER APPLY (
		SELECT
			COUNT(*) AS [day_count],
			ISNULL(SUM(CASE WHEN [b].[day_id] IS NOT NULL THEN 1 ELSE 0 END), 0) AS [blackout_count],
			ISNULL(SUM(CASE WHEN [b].[day_id] IS NULL THEN 1 ELSE 0 END), 0) AS [n],
			ISNULL(SUM(CASE WHEN [b].[day_id] IS NULL AND [d].[state] = N'RETURNED' THEN 1 ELSE 0 END), 0) AS [returned],
			ISNULL(SUM(CASE WHEN [b].[day_id] IS NULL AND [d].[state] = N'APPROVED' THEN 1 ELSE 0 END), 0) AS [approved],
			ISNULL(SUM(CASE WHEN [b].[day_id] IS NULL AND [d].[state] IN (N'SUBMITTED', N'RESUBMITTED', N'PRIMARY_APPROVED', N'APPROVED') THEN 1 ELSE 0 END), 0) AS [submitted_or_later],
			ISNULL(SUM(CASE WHEN [b].[day_id] IS NULL AND [d].[state] = N'DRAFT' THEN 1 ELSE 0 END), 0) AS [draft]
		FROM [$(PROGRAM_SCHEMA)].[timesheet_day] AS [d]
		LEFT JOIN [$(PROGRAM_SCHEMA)].[blackout] AS [b] ON [b].[day_id] = [d].[day_id]
		WHERE [d].[timesheet_id] = [t].[timesheet_id]
	) AS [c]
);
GO

-- Status row of one timesheet as of @asOf; empty when the sheet does not exist.
CREATE OR ALTER PROCEDURE [$(PROGRAM_SCHEMA)].[usp_timesheet_status]
	@timesheet_id char(35),
	@asOf datetime
AS
BEGIN
	SET NOCOUNT ON; SET XACT_ABORT ON;

	SELECT [s].[timesheet_id], [s].[status], [s].[overdue], [s].[day_count], [s].[blackout_count], [s].[approved_count]
	FROM [$(PROGRAM_SCHEMA)].[tvf_timesheet_status](@asOf) AS [s]
	WHERE [s].[timesheet_id] = @timesheet_id;
END
GO

-- Status rows of a site's timesheets as of @asOf, ordered by period, person and sheet.
CREATE OR ALTER PROCEDURE [$(PROGRAM_SCHEMA)].[usp_timesheet_status_list]
	@siteID nvarchar(25),
	@asOf datetime
AS
BEGIN
	SET NOCOUNT ON; SET XACT_ABORT ON;

	-- Binary collation keeps the id order independent of the database collation, as an ordinal string sort.
	SELECT [s].[timesheet_id], [s].[status], [s].[overdue], [s].[day_count], [s].[blackout_count], [s].[approved_count]
	FROM [$(PROGRAM_SCHEMA)].[tvf_timesheet_status](@asOf) AS [s]
	WHERE [s].[siteID] = @siteID
	ORDER BY [s].[period_start], [s].[person_id] COLLATE Latin1_General_BIN2, [s].[timesheet_id] COLLATE Latin1_General_BIN2;
END
GO

-- Applies a day lifecycle action under the loaded transition table; @roles is a comma list of held group names; returns (outcome, status, to_state, error).
CREATE OR ALTER PROCEDURE [$(PROGRAM_SCHEMA)].[usp_timesheet_day_action]
	@day_id char(35),
	@action nvarchar(30),
	@roles nvarchar(4000),
	@actor_user_id char(35),
	@comment nvarchar(max),
	@action_id char(35),
	@now datetime
AS
BEGIN
	SET NOCOUNT ON; SET XACT_ABORT ON;

	DECLARE @state nvarchar(20);
	DECLARE @role nvarchar(50);
	DECLARE @outcome nvarchar(15);
	DECLARE @status nvarchar(3);
	DECLARE @to_state nvarchar(20);
	DECLARE @error nvarchar(50);
	DECLARE @held TABLE ([role] nvarchar(4000) NOT NULL);

	BEGIN TRANSACTION;

	SELECT @state = [state]
	FROM [$(PROGRAM_SCHEMA)].[timesheet_day] WITH (UPDLOCK, HOLDLOCK)
	WHERE [day_id] = @day_id;

	IF @@ROWCOUNT = 0
		SELECT @outcome = N'not-found', @status = N'404';
	ELSE
	BEGIN
		-- Checked only for an existing day, as in the finance fixture's shared enforcement rule.
		IF NOT EXISTS (SELECT 1 FROM [synthetic].[timesheet_transition])
			OR NOT EXISTS (SELECT 1 FROM [synthetic].[transition_rule] WHERE [service] = N'timesheets' AND [rule_name] = N'blackout')
			THROW 50010, N'timesheet transitions not loaded', 1;

		IF EXISTS (SELECT 1 FROM [$(PROGRAM_SCHEMA)].[blackout] WHERE [day_id] = @day_id)
			SELECT @outcome = [r].[outcome], @status = [r].[status], @error = [r].[error]
			FROM [synthetic].[transition_rule] AS [r]
			WHERE [r].[service] = N'timesheets' AND [r].[rule_name] = N'blackout';
		ELSE
		BEGIN
			INSERT INTO @held ([role])
			SELECT DISTINCT LTRIM(RTRIM([value]))
			FROM STRING_SPLIT(COALESCE(@roles, N''), N',')
			WHERE LTRIM(RTRIM([value])) <> N'';

			SELECT TOP (1) @outcome = [t].[outcome], @status = [t].[status], @to_state = [t].[to_state], @role = [t].[role]
			FROM [synthetic].[timesheet_transition] AS [t]
			WHERE [t].[from_state] = @state AND [t].[action] = @action AND [t].[outcome] = N'legal'
				AND [t].[role] IN (SELECT [h].[role] FROM @held AS [h])
			ORDER BY [t].[role];

			IF @outcome IS NULL
				SELECT TOP (1) @outcome = N'illegal-state', @status = N'409', @error = [t].[error]
				FROM [synthetic].[timesheet_transition] AS [t]
				WHERE [t].[from_state] = @state AND [t].[action] = @action AND [t].[outcome] = N'illegal-state'
					AND [t].[role] IN (SELECT [h].[role] FROM @held AS [h])
				ORDER BY [t].[role];

			IF @outcome IS NULL
				SELECT @outcome = N'wrong-role', @status = N'403';

			IF @outcome = N'legal'
			BEGIN
				UPDATE [$(PROGRAM_SCHEMA)].[timesheet_day]
				SET [state] = @to_state, [lastUpdate] = @now, [lastUpdateByID] = @actor_user_id
				WHERE [day_id] = @day_id;

				INSERT INTO [$(PROGRAM_SCHEMA)].[approval_action] ([action_id], [day_id], [action], [role], [from_state], [to_state], [actor_user_id], [comment], [created])
				VALUES (ISNULL(@action_id, STUFF(CONVERT(char(36), NEWID()), 24, 1, '')), @day_id, @action, @role, @state, @to_state, @actor_user_id, @comment, @now);
			END
		END
	END

	COMMIT TRANSACTION;

	SELECT @outcome AS [outcome], @status AS [status], @to_state AS [to_state], @error AS [error];
END
GO

-- Blacks out the person's open days on or after @effective_from that have none yet; @blackouts returns the rows inserted.
CREATE OR ALTER PROCEDURE [$(PROGRAM_SCHEMA)].[usp_apply_blackout]
	@person_id char(35),
	@effective_from datetime,
	@archive_id char(35),
	@now datetime,
	@blackouts int OUTPUT
AS
BEGIN
	SET NOCOUNT ON; SET XACT_ABORT ON;

	INSERT INTO [$(PROGRAM_SCHEMA)].[blackout] ([blackout_id], [day_id], [person_id], [archive_id], [created])
	SELECT STUFF(CONVERT(char(36), NEWID()), 24, 1, ''), [d].[day_id], @person_id, @archive_id, @now
	FROM [$(PROGRAM_SCHEMA)].[timesheet_day] AS [d]
	INNER JOIN [$(PROGRAM_SCHEMA)].[timesheet] AS [t] ON [t].[timesheet_id] = [d].[timesheet_id]
	WHERE [t].[person_id] = @person_id AND [d].[state] <> N'APPROVED' AND [d].[work_date] >= @effective_from
		AND NOT EXISTS (SELECT 1 FROM [$(PROGRAM_SCHEMA)].[blackout] AS [b] WHERE [b].[day_id] = [d].[day_id]);

	SET @blackouts = @@ROWCOUNT;
END
GO
