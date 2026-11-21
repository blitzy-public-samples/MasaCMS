-- SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

-- Inserts the surveys rows of @json ({"<table>": [rows]}) whose ids are absent; returns one row of per-table inserted counts.
CREATE OR ALTER PROCEDURE [synthetic].[usp_seed_surveys] @json [nvarchar] (max) AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @surveys [int], @schedules [int], @reminders [int], @targets [int], @responses [int];

    BEGIN TRANSACTION;

    INSERT INTO [synthetic].[survey]
        ([survey_id], [siteID], [title], [status], [created], [createdByID], [lastUpdate], [lastUpdateByID], [launched_at])
    SELECT
        j.[survey_id], j.[siteID], j.[title], COALESCE(j.[status], N'DRAFT'),
        CONVERT([datetime], j.[created], 126), j.[createdByID],
        CONVERT([datetime], j.[lastUpdate], 126), j.[lastUpdateByID],
        CONVERT([datetime], j.[launched_at], 126)
    FROM OPENJSON(@json, '$.survey') WITH (
        [survey_id] [char] (35) '$.survey_id',
        [siteID] [nvarchar] (25) '$.siteID',
        [title] [nvarchar] (255) '$.title',
        [status] [nvarchar] (20) '$.status',
        [created] [nvarchar] (23) '$.created',
        [createdByID] [char] (35) '$.createdByID',
        [lastUpdate] [nvarchar] (23) '$.lastUpdate',
        [lastUpdateByID] [char] (35) '$.lastUpdateByID',
        [launched_at] [nvarchar] (23) '$.launched_at'
    ) AS j
    WHERE NOT EXISTS (SELECT 1 FROM [synthetic].[survey] t WHERE t.[survey_id] = j.[survey_id]);
    SET @surveys = @@ROWCOUNT;

    INSERT INTO [synthetic].[survey_schedule]
        ([schedule_id], [survey_id], [launch_at], [schedule_version], [task_name], [task_token_hash], [created])
    SELECT
        j.[schedule_id], j.[survey_id], CONVERT([datetime], j.[launch_at], 126), j.[schedule_version],
        j.[task_name], j.[task_token_hash], CONVERT([datetime], j.[created], 126)
    FROM OPENJSON(@json, '$.survey_schedule') WITH (
        [schedule_id] [char] (35) '$.schedule_id',
        [survey_id] [char] (35) '$.survey_id',
        [launch_at] [nvarchar] (23) '$.launch_at',
        [schedule_version] [int] '$.schedule_version',
        [task_name] [nvarchar] (100) '$.task_name',
        [task_token_hash] [char] (64) '$.task_token_hash',
        [created] [nvarchar] (23) '$.created'
    ) AS j
    WHERE NOT EXISTS (SELECT 1 FROM [synthetic].[survey_schedule] t WHERE t.[schedule_id] = j.[schedule_id]);
    SET @schedules = @@ROWCOUNT;

    INSERT INTO [synthetic].[survey_reminder]
        ([reminder_id], [survey_id], [offset_minutes], [remind_at], [task_name], [task_token_hash], [sent_at])
    SELECT
        j.[reminder_id], j.[survey_id], j.[offset_minutes], CONVERT([datetime], j.[remind_at], 126),
        j.[task_name], j.[task_token_hash], CONVERT([datetime], j.[sent_at], 126)
    FROM OPENJSON(@json, '$.survey_reminder') WITH (
        [reminder_id] [char] (35) '$.reminder_id',
        [survey_id] [char] (35) '$.survey_id',
        [offset_minutes] [int] '$.offset_minutes',
        [remind_at] [nvarchar] (23) '$.remind_at',
        [task_name] [nvarchar] (100) '$.task_name',
        [task_token_hash] [char] (64) '$.task_token_hash',
        [sent_at] [nvarchar] (23) '$.sent_at'
    ) AS j
    WHERE NOT EXISTS (SELECT 1 FROM [synthetic].[survey_reminder] t WHERE t.[reminder_id] = j.[reminder_id]);
    SET @reminders = @@ROWCOUNT;

    INSERT INTO [synthetic].[survey_target]
        ([target_id], [survey_id], [siteID], [group_name], [created])
    SELECT
        j.[target_id], j.[survey_id], j.[siteID], j.[group_name], CONVERT([datetime], j.[created], 126)
    FROM OPENJSON(@json, '$.survey_target') WITH (
        [target_id] [char] (35) '$.target_id',
        [survey_id] [char] (35) '$.survey_id',
        [siteID] [nvarchar] (25) '$.siteID',
        [group_name] [nvarchar] (255) '$.group_name',
        [created] [nvarchar] (23) '$.created'
    ) AS j
    WHERE NOT EXISTS (SELECT 1 FROM [synthetic].[survey_target] t WHERE t.[target_id] = j.[target_id]);
    SET @targets = @@ROWCOUNT;

    INSERT INTO [synthetic].[survey_response]
        ([response_id], [survey_id], [siteID], [respondentSiteID], [respondent_user_id], [answers], [created])
    SELECT
        j.[response_id], j.[survey_id], j.[siteID], j.[respondentSiteID], j.[respondent_user_id],
        j.[answers], CONVERT([datetime], j.[created], 126)
    FROM OPENJSON(@json, '$.survey_response') WITH (
        [response_id] [char] (35) '$.response_id',
        [survey_id] [char] (35) '$.survey_id',
        [siteID] [nvarchar] (25) '$.siteID',
        [respondentSiteID] [nvarchar] (25) '$.respondentSiteID',
        [respondent_user_id] [char] (35) '$.respondent_user_id',
        [answers] [nvarchar] (max) '$.answers',
        [created] [nvarchar] (23) '$.created'
    ) AS j
    WHERE NOT EXISTS (SELECT 1 FROM [synthetic].[survey_response] t WHERE t.[response_id] = j.[response_id]);
    SET @responses = @@ROWCOUNT;

    SELECT @surveys AS [surveys], @schedules AS [schedules], @reminders AS [reminders], @targets AS [targets], @responses AS [responses];

    COMMIT TRANSACTION;
END
GO
