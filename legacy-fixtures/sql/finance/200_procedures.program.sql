-- SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON;
GO

-- Creates an IN-PROGRESS finance record and its version-1 row; returns the record row.
CREATE OR ALTER PROCEDURE [$(PROGRAM_SCHEMA)].[usp_finance_create]
	@record_id char(35),
	@siteID nvarchar(25),
	@title nvarchar(255),
	@amount numeric(19,4),
	@period nvarchar(7),
	@actor_user_id char(35),
	@version_id char(35),
	@now datetime
AS
BEGIN
	SET NOCOUNT ON; SET XACT_ABORT ON;

	DECLARE @rc int;
	DECLARE @max_total numeric(19,4) = 999999999999999.9999;

	BEGIN TRANSACTION;

	-- One writer per program at a time, held to the end of the caller's transaction, so writes and their rollup rebuild never deadlock.
	EXEC @rc = sp_getapplock @Resource = N'$(PROGRAM_SCHEMA).finance', @LockMode = N'Exclusive', @LockOwner = N'Transaction';
	IF @rc < 0
		THROW 50012, N'finance program lock not granted', 1;

	-- Every per-state total of a period lies between its negative and positive sums, so bounding both keeps usp_finance_rollup within numeric(19,4).
	IF EXISTS (
		SELECT 1
		FROM (
			SELECT [amount] FROM [$(PROGRAM_SCHEMA)].[finance_record] WHERE [period] = @period
			UNION ALL SELECT @amount
		) AS [p]
		HAVING SUM(CASE WHEN [p].[amount] > 0 THEN [p].[amount] ELSE 0 END) > @max_total
			OR SUM(CASE WHEN [p].[amount] < 0 THEN [p].[amount] ELSE 0 END) < -@max_total
	)
		THROW 50020, N'finance period total out of range', 1;

	INSERT INTO [$(PROGRAM_SCHEMA)].[finance_record] ([record_id], [siteID], [title], [amount], [period], [state], [version], [created], [createdByID], [lastUpdate], [lastUpdateByID])
	VALUES (@record_id, @siteID, @title, @amount, @period, N'IN-PROGRESS', 1, @now, @actor_user_id, NULL, NULL);

	INSERT INTO [$(PROGRAM_SCHEMA)].[finance_record_version] ([version_id], [record_id], [version], [state], [title], [amount], [period], [action], [actor_user_id], [created])
	VALUES (COALESCE(@version_id, STUFF(CONVERT(char(36), NEWID()), 24, 1, '')), @record_id, 1, N'IN-PROGRESS', @title, @amount, @period, N'create', @actor_user_id, @now);

	COMMIT TRANSACTION;

	SELECT [record_id], [siteID], [title], CONVERT(varchar(40), [amount]) AS [amount], [period], [state], [version], [created], [createdByID], [lastUpdate], [lastUpdateByID]
	FROM [$(PROGRAM_SCHEMA)].[finance_record]
	WHERE [record_id] = @record_id;
END
GO

-- Applies a lifecycle action under the loaded transition table; @roles is a comma list of held group names; returns (outcome, status, to_state, error).
CREATE OR ALTER PROCEDURE [$(PROGRAM_SCHEMA)].[usp_finance_transition]
	@record_id char(35),
	@action nvarchar(30),
	@roles nvarchar(4000),
	@actor_user_id char(35),
	@version_id char(35),
	@now datetime,
	@title nvarchar(255) = NULL,
	@amount numeric(19,4) = NULL,
	@period nvarchar(7) = NULL
AS
BEGIN
	SET NOCOUNT ON; SET XACT_ABORT ON;

	DECLARE @state nvarchar(20);
	DECLARE @version int;
	DECLARE @cur_title nvarchar(255);
	DECLARE @cur_amount numeric(19,4);
	DECLARE @cur_period nvarchar(7);
	DECLARE @new_state nvarchar(20);
	DECLARE @outcome nvarchar(15);
	DECLARE @status nvarchar(3);
	DECLARE @to_state nvarchar(20);
	DECLARE @error nvarchar(50);
	DECLARE @held TABLE ([role] nvarchar(4000) NOT NULL);
	DECLARE @rc int;
	DECLARE @max_total numeric(19,4) = 999999999999999.9999;

	BEGIN TRANSACTION;

	EXEC @rc = sp_getapplock @Resource = N'$(PROGRAM_SCHEMA).finance', @LockMode = N'Exclusive', @LockOwner = N'Transaction';
	IF @rc < 0
		THROW 50012, N'finance program lock not granted', 1;

	SELECT @state = [state], @version = [version], @cur_title = [title], @cur_amount = [amount], @cur_period = [period]
	FROM [$(PROGRAM_SCHEMA)].[finance_record] WITH (UPDLOCK, HOLDLOCK)
	WHERE [record_id] = @record_id;

	IF @@ROWCOUNT = 0
		SELECT @outcome = N'not-found', @status = N'404';
	ELSE
	BEGIN
		IF NOT EXISTS (SELECT 1 FROM [synthetic].[finance_transition])
			THROW 50010, N'finance transitions not loaded', 1;

		INSERT INTO @held ([role])
		SELECT DISTINCT LTRIM(RTRIM([value]))
		FROM STRING_SPLIT(COALESCE(@roles, N''), N',')
		WHERE LTRIM(RTRIM([value])) <> N'';

		SELECT TOP (1) @outcome = [t].[outcome], @status = [t].[status], @to_state = [t].[to_state]
		FROM [synthetic].[finance_transition] AS [t]
		WHERE [t].[from_state] = @state AND [t].[action] = @action AND [t].[outcome] = N'legal'
			AND [t].[role] IN (SELECT [h].[role] FROM @held AS [h])
		ORDER BY [t].[role];

		IF @outcome IS NULL
			SELECT TOP (1) @outcome = N'illegal-state', @status = N'409', @error = [t].[error]
			FROM [synthetic].[finance_transition] AS [t]
			WHERE [t].[from_state] = @state AND [t].[action] = @action AND [t].[outcome] = N'illegal-state'
				AND [t].[role] IN (SELECT [h].[role] FROM @held AS [h])
			ORDER BY [t].[role];

		IF @outcome IS NULL
			SELECT @outcome = N'wrong-role', @status = N'403';

		IF @outcome = N'legal'
		BEGIN
			SET @new_state = COALESCE(@to_state, @state);
			SET @to_state = @new_state;

			IF @action = N'edit'
			BEGIN
				SELECT @cur_title = COALESCE(@title, @cur_title), @cur_amount = COALESCE(@amount, @cur_amount), @cur_period = COALESCE(@period, @cur_period);

				-- Other actions keep each record's period and amount, so only an edit can move a period's sums.
				IF EXISTS (
					SELECT 1
					FROM (
						SELECT [amount] FROM [$(PROGRAM_SCHEMA)].[finance_record] WHERE [period] = @cur_period AND [record_id] <> @record_id
						UNION ALL SELECT @cur_amount
					) AS [p]
					HAVING SUM(CASE WHEN [p].[amount] > 0 THEN [p].[amount] ELSE 0 END) > @max_total
						OR SUM(CASE WHEN [p].[amount] < 0 THEN [p].[amount] ELSE 0 END) < -@max_total
				)
					THROW 50020, N'finance period total out of range', 1;
			END

			UPDATE [$(PROGRAM_SCHEMA)].[finance_record]
			SET [state] = @new_state, [title] = @cur_title, [amount] = @cur_amount, [period] = @cur_period,
				[version] = @version + 1, [lastUpdate] = @now, [lastUpdateByID] = @actor_user_id
			WHERE [record_id] = @record_id;

			INSERT INTO [$(PROGRAM_SCHEMA)].[finance_record_version] ([version_id], [record_id], [version], [state], [title], [amount], [period], [action], [actor_user_id], [created])
			VALUES (COALESCE(@version_id, STUFF(CONVERT(char(36), NEWID()), 24, 1, '')), @record_id, @version + 1, @new_state, @cur_title, @cur_amount, @cur_period, @action, @actor_user_id, @now);
		END
	END

	COMMIT TRANSACTION;

	SELECT @outcome AS [outcome], @status AS [status], @to_state AS [to_state], @error AS [error];
END
GO

-- Rebuilds per-period, per-state totals and returns them.
CREATE OR ALTER PROCEDURE [$(PROGRAM_SCHEMA)].[usp_finance_rollup]
	@now datetime
AS
BEGIN
	SET NOCOUNT ON; SET XACT_ABORT ON;

	DECLARE @rc int;

	BEGIN TRANSACTION;

	EXEC @rc = sp_getapplock @Resource = N'$(PROGRAM_SCHEMA).finance', @LockMode = N'Exclusive', @LockOwner = N'Transaction';
	IF @rc < 0
		THROW 50012, N'finance program lock not granted', 1;

	DELETE FROM [$(PROGRAM_SCHEMA)].[finance_rollup] WITH (TABLOCKX, HOLDLOCK);

	INSERT INTO [$(PROGRAM_SCHEMA)].[finance_rollup] ([period], [state], [record_count], [total_amount], [computed_at])
	SELECT [period], [state], COUNT(*), CAST(SUM([amount]) AS numeric(19,4)), @now
	FROM [$(PROGRAM_SCHEMA)].[finance_record]
	GROUP BY [period], [state];

	COMMIT TRANSACTION;

	SELECT [period], [state], [record_count], CONVERT(varchar(40), [total_amount]) AS [total_amount], [computed_at]
	FROM [$(PROGRAM_SCHEMA)].[finance_rollup]
	ORDER BY [period] COLLATE Latin1_General_BIN2, [state] COLLATE Latin1_General_BIN2;
END
GO
