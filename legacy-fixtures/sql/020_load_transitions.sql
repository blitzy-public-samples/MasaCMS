-- SYNTHETIC: legacy-fixtures - no Masa equivalent; legacy oracle in legacy-fixtures/
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

-- Rules of an exported state machine that apply outside its rows, such as the timesheets blackout rule.
IF OBJECT_ID(N'[synthetic].[transition_rule]', N'U') IS NULL
CREATE TABLE [synthetic].[transition_rule] (
	[service] [nvarchar] (20) NOT NULL ,
	[rule_name] [nvarchar] (30) NOT NULL ,
	[applies_to] [nvarchar] (100) NULL ,
	[outcome] [nvarchar] (15) NOT NULL ,
	[status] [nvarchar] (3) NOT NULL ,
	[error] [nvarchar] (50) NULL ,
	CONSTRAINT [PK_transition_rule] PRIMARY KEY CLUSTERED ([service], [rule_name])
) ON [PRIMARY];
GO

-- Replaces a service's transition rows and rules with its state-machine export; @json is the full export file text.
CREATE OR ALTER PROCEDURE [synthetic].[usp_load_transitions]
	@service nvarchar(20),
	@json nvarchar(max)
AS
BEGIN
	SET NOCOUNT ON; SET XACT_ABORT ON;

	IF ISNULL(@service, N'') NOT IN (N'finance', N'timesheets') THROW 50001, N'usp_load_transitions: unknown service', 1;
	IF COALESCE(CASE WHEN ISJSON(@json) = 1 THEN JSON_VALUE(@json, '$.service') END, N'') <> @service THROW 50002, N'usp_load_transitions: input is not the state-machine export of this service', 1;
	IF @service = N'timesheets' AND JSON_QUERY(@json, '$.blackout') IS NULL THROW 50003, N'usp_load_transitions: timesheets export has no blackout rule', 1;

	DECLARE @transitions int = 0;
	DECLARE @rules int = 0;
	-- Text is parsed at nvarchar(4000) because OPENJSON truncates silently; an oversized value fails on the target column instead.
	DECLARE @rows TABLE (
		[from_state] nvarchar(4000) NULL,
		[action] nvarchar(4000) NULL,
		[role] nvarchar(4000) NULL,
		[outcome] nvarchar(4000) NULL,
		[status] nvarchar(4000) NULL,
		[to_state] nvarchar(4000) NULL,
		[new_version] tinyint NULL,
		[error] nvarchar(4000) NULL
	);

	INSERT INTO @rows ([from_state], [action], [role], [outcome], [status], [to_state], [new_version], [error])
	SELECT [r].[from_state], [r].[action], [r].[role], [r].[outcome], [r].[status], [r].[to_state],
		CASE [r].[new_version_raw] WHEN N'true' THEN 1 WHEN N'false' THEN 0 ELSE CONVERT(tinyint, [r].[new_version_raw]) END,
		[r].[error]
	FROM OPENJSON(@json, '$.rows') WITH (
		[from_state] nvarchar(4000) '$.from',
		[action] nvarchar(4000) '$.action',
		[role] nvarchar(4000) '$.role',
		[outcome] nvarchar(4000) '$.outcome',
		[status] nvarchar(4000) '$.status',
		[to_state] nvarchar(4000) '$.to',
		[new_version_raw] nvarchar(4000) '$.newVersion',
		[error] nvarchar(4000) '$.error'
	) AS [r];

	BEGIN TRANSACTION;

	IF @service = N'finance'
	BEGIN
		DELETE FROM [synthetic].[finance_transition];
		INSERT INTO [synthetic].[finance_transition] ([from_state], [action], [role], [outcome], [status], [to_state], [new_version], [error])
		SELECT [from_state], [action], [role], [outcome], [status], [to_state], [new_version], [error] FROM @rows;
		SET @transitions = @@ROWCOUNT;
	END
	ELSE
	BEGIN
		DELETE FROM [synthetic].[timesheet_transition];
		INSERT INTO [synthetic].[timesheet_transition] ([from_state], [action], [role], [outcome], [status], [to_state], [new_version], [error])
		SELECT [from_state], [action], [role], [outcome], [status], [to_state], [new_version], [error] FROM @rows;
		SET @transitions = @@ROWCOUNT;
	END

	DELETE FROM [synthetic].[transition_rule] WHERE [service] = @service;

	-- OPENJSON, not JSON_VALUE: the optimizer folds JSON_VALUE(@json) in a table INSERT at compile time, raising on invalid input before the checks run.
	IF @service = N'timesheets'
	BEGIN
		INSERT INTO [synthetic].[transition_rule] ([service], [rule_name], [applies_to], [outcome], [status], [error])
		SELECT @service, N'blackout', COALESCE([b].[applies_to], [b].[applies_to_json]), [b].[outcome], [b].[status], [b].[error]
		FROM OPENJSON(@json, '$.blackout') WITH (
			[applies_to] nvarchar(4000) '$.appliesTo',
			[applies_to_json] nvarchar(max) '$.appliesTo' AS JSON,
			[outcome] nvarchar(4000) '$.outcome',
			[status] nvarchar(4000) '$.status',
			[error] nvarchar(4000) '$.error'
		) AS [b];
		SET @rules = @@ROWCOUNT;
	END

	COMMIT TRANSACTION;

	SELECT @service AS [service], @transitions AS [transitions_loaded], @rules AS [rules_loaded];
END
GO
