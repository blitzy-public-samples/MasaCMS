-- SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

-- Inserts the @json arrays timesheet, timesheet_day, approval_action and blackout, skipping rows whose primary key exists; returns one row of inserted counts.
CREATE OR ALTER PROCEDURE [$(PROGRAM_SCHEMA)].[usp_seed_timesheets] @json nvarchar(max) AS
BEGIN
	SET NOCOUNT ON; SET XACT_ABORT ON;

	DECLARE @timesheets int = 0, @days int = 0, @approval_actions int = 0, @blackouts int = 0;

	BEGIN TRANSACTION;

	INSERT INTO [$(PROGRAM_SCHEMA)].[timesheet] (
		[timesheet_id], [person_id], [siteID], [period_start], [period_end], [due_date],
		[created], [lastUpdate], [lastUpdateByID]
	)
	SELECT
		j.[timesheet_id],
		j.[person_id],
		j.[siteID],
		CONVERT(datetime, j.[period_start], 126),
		CONVERT(datetime, j.[period_end], 126),
		CONVERT(datetime, j.[due_date], 126),
		CONVERT(datetime, j.[created], 126),
		CONVERT(datetime, j.[lastUpdate], 126),
		j.[lastUpdateByID]
	FROM OPENJSON(@json, N'$.timesheet') WITH (
		[timesheet_id] char(35) N'$.timesheet_id',
		[person_id] char(35) N'$.person_id',
		[siteID] nvarchar(25) N'$.siteID',
		[period_start] nvarchar(23) N'$.period_start',
		[period_end] nvarchar(23) N'$.period_end',
		[due_date] nvarchar(23) N'$.due_date',
		[created] nvarchar(23) N'$.created',
		[lastUpdate] nvarchar(23) N'$.lastUpdate',
		[lastUpdateByID] char(35) N'$.lastUpdateByID'
	) AS j
	WHERE NOT EXISTS (SELECT 1 FROM [$(PROGRAM_SCHEMA)].[timesheet] x WHERE x.[timesheet_id] = j.[timesheet_id]);
	SET @timesheets = @@ROWCOUNT;

	INSERT INTO [$(PROGRAM_SCHEMA)].[timesheet_day] (
		[day_id], [timesheet_id], [work_date], [hours], [state], [lastUpdate], [lastUpdateByID]
	)
	SELECT
		j.[day_id],
		j.[timesheet_id],
		CONVERT(datetime, j.[work_date], 126),
		CONVERT(numeric(19, 4), j.[hours]),
		COALESCE(j.[state], N'DRAFT'),
		CONVERT(datetime, j.[lastUpdate], 126),
		j.[lastUpdateByID]
	FROM OPENJSON(@json, N'$.timesheet_day') WITH (
		[day_id] char(35) N'$.day_id',
		[timesheet_id] char(35) N'$.timesheet_id',
		[work_date] nvarchar(23) N'$.work_date',
		[hours] nvarchar(40) N'$.hours',
		[state] nvarchar(20) N'$.state',
		[lastUpdate] nvarchar(23) N'$.lastUpdate',
		[lastUpdateByID] char(35) N'$.lastUpdateByID'
	) AS j
	WHERE NOT EXISTS (SELECT 1 FROM [$(PROGRAM_SCHEMA)].[timesheet_day] x WHERE x.[day_id] = j.[day_id]);
	SET @days = @@ROWCOUNT;

	INSERT INTO [$(PROGRAM_SCHEMA)].[approval_action] (
		[action_id], [day_id], [action], [role], [from_state], [to_state],
		[actor_user_id], [comment], [created]
	)
	SELECT
		j.[action_id],
		j.[day_id],
		j.[action],
		j.[role],
		j.[from_state],
		j.[to_state],
		j.[actor_user_id],
		j.[comment],
		CONVERT(datetime, j.[created], 126)
	FROM OPENJSON(@json, N'$.approval_action') WITH (
		[action_id] char(35) N'$.action_id',
		[day_id] char(35) N'$.day_id',
		[action] nvarchar(30) N'$.action',
		[role] nvarchar(50) N'$.role',
		[from_state] nvarchar(20) N'$.from_state',
		[to_state] nvarchar(20) N'$.to_state',
		[actor_user_id] char(35) N'$.actor_user_id',
		[comment] nvarchar(max) N'$.comment',
		[created] nvarchar(23) N'$.created'
	) AS j
	WHERE NOT EXISTS (SELECT 1 FROM [$(PROGRAM_SCHEMA)].[approval_action] x WHERE x.[action_id] = j.[action_id]);
	SET @approval_actions = @@ROWCOUNT;

	INSERT INTO [$(PROGRAM_SCHEMA)].[blackout] (
		[blackout_id], [day_id], [person_id], [archive_id], [reason], [created]
	)
	SELECT
		j.[blackout_id],
		j.[day_id],
		j.[person_id],
		j.[archive_id],
		COALESCE(j.[reason], N'person-archived'),
		CONVERT(datetime, j.[created], 126)
	FROM OPENJSON(@json, N'$.blackout') WITH (
		[blackout_id] char(35) N'$.blackout_id',
		[day_id] char(35) N'$.day_id',
		[person_id] char(35) N'$.person_id',
		[archive_id] char(35) N'$.archive_id',
		[reason] nvarchar(50) N'$.reason',
		[created] nvarchar(23) N'$.created'
	) AS j
	WHERE NOT EXISTS (SELECT 1 FROM [$(PROGRAM_SCHEMA)].[blackout] x WHERE x.[blackout_id] = j.[blackout_id]);
	SET @blackouts = @@ROWCOUNT;

	COMMIT TRANSACTION;

	SELECT @timesheets AS [timesheets], @days AS [days], @approval_actions AS [approval_actions], @blackouts AS [blackouts];
END
GO
