-- SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

-- Inserts the @json seed document's message_template, message and delivery_status rows not yet present; returns one row of inserted counts.
CREATE OR ALTER PROCEDURE [synthetic].[usp_seed_communications]
	@json [nvarchar] (max)
AS
BEGIN
	SET NOCOUNT ON;
	SET XACT_ABORT ON;

	DECLARE @templates [int] = 0;
	DECLARE @messages [int] = 0;
	DECLARE @statuses [int] = 0;

	BEGIN TRANSACTION;

	INSERT INTO [synthetic].[message_template] ([template_id], [siteID], [name], [subject], [body_text], [body_html], [created], [lastUpdate])
	SELECT
		j.[template_id],
		j.[siteID],
		j.[name],
		j.[subject],
		j.[body_text],
		j.[body_html],
		CONVERT([datetime], j.[created], 126),
		CONVERT([datetime], j.[lastUpdate], 126)
	FROM OPENJSON(@json, N'$.message_template') WITH (
		[template_id] [char] (35) N'$.template_id' ,
		[siteID] [nvarchar] (25) N'$.siteID' ,
		[name] [nvarchar] (100) N'$.name' ,
		[subject] [nvarchar] (255) N'$.subject' ,
		[body_text] [nvarchar] (max) N'$.body_text' ,
		[body_html] [nvarchar] (max) N'$.body_html' ,
		[created] [nvarchar] (23) N'$.created' ,
		[lastUpdate] [nvarchar] (23) N'$.lastUpdate'
	) AS j
	WHERE NOT EXISTS (SELECT 1 FROM [synthetic].[message_template] AS t WHERE t.[template_id] = j.[template_id]);
	SET @templates = @@ROWCOUNT;

	INSERT INTO [synthetic].[message] ([message_id], [siteID], [template_id], [to_address], [from_address], [subject], [body_text], [body_html], [state], [created], [sent_at])
	SELECT
		j.[message_id],
		j.[siteID],
		j.[template_id],
		j.[to_address],
		j.[from_address],
		j.[subject],
		j.[body_text],
		j.[body_html],
		ISNULL(j.[state], N'queued'),
		CONVERT([datetime], j.[created], 126),
		CONVERT([datetime], j.[sent_at], 126)
	FROM OPENJSON(@json, N'$.message') WITH (
		[message_id] [char] (35) N'$.message_id' ,
		[siteID] [nvarchar] (25) N'$.siteID' ,
		[template_id] [char] (35) N'$.template_id' ,
		[to_address] [nvarchar] (255) N'$.to_address' ,
		[from_address] [nvarchar] (255) N'$.from_address' ,
		[subject] [nvarchar] (255) N'$.subject' ,
		[body_text] [nvarchar] (max) N'$.body_text' ,
		[body_html] [nvarchar] (max) N'$.body_html' ,
		[state] [nvarchar] (10) N'$.state' ,
		[created] [nvarchar] (23) N'$.created' ,
		[sent_at] [nvarchar] (23) N'$.sent_at'
	) AS j
	WHERE NOT EXISTS (SELECT 1 FROM [synthetic].[message] AS t WHERE t.[message_id] = j.[message_id]);
	SET @messages = @@ROWCOUNT;

	INSERT INTO [synthetic].[delivery_status] ([status_id], [message_id], [status], [detail], [mailpit_id], [recorded_at])
	SELECT
		j.[status_id],
		j.[message_id],
		j.[status],
		j.[detail],
		j.[mailpit_id],
		CONVERT([datetime], j.[recorded_at], 126)
	FROM OPENJSON(@json, N'$.delivery_status') WITH (
		[status_id] [char] (35) N'$.status_id' ,
		[message_id] [char] (35) N'$.message_id' ,
		[status] [nvarchar] (10) N'$.status' ,
		[detail] [nvarchar] (max) N'$.detail' ,
		[mailpit_id] [nvarchar] (100) N'$.mailpit_id' ,
		[recorded_at] [nvarchar] (23) N'$.recorded_at'
	) AS j
	WHERE NOT EXISTS (SELECT 1 FROM [synthetic].[delivery_status] AS t WHERE t.[status_id] = j.[status_id]);
	SET @statuses = @@ROWCOUNT;

	COMMIT TRANSACTION;

	SELECT @templates AS [templates], @messages AS [messages], @statuses AS [statuses];
END
GO
