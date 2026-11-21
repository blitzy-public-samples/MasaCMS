-- SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

-- Export definitions: data source and column list per site.
IF OBJECT_ID(N'[synthetic].[export_definition]', N'U') IS NULL
BEGIN
	CREATE TABLE [synthetic].[export_definition] (
		[definition_id] [char] (35) NOT NULL ,
		[siteID] [nvarchar] (25) NOT NULL ,
		[name] [nvarchar] (100) NOT NULL ,
		[source] [nvarchar] (50) NOT NULL ,
		[columns] [nvarchar] (max) NOT NULL ,
		CONSTRAINT [PK_export_definition] PRIMARY KEY CLUSTERED ([definition_id])
	) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]
END
GO

-- Export jobs and their generated output.
IF OBJECT_ID(N'[synthetic].[export_job]', N'U') IS NULL
BEGIN
	CREATE TABLE [synthetic].[export_job] (
		[job_id] [char] (35) NOT NULL ,
		[siteID] [nvarchar] (25) NOT NULL ,
		[definition_id] [char] (35) NOT NULL ,
		[format] [nvarchar] (4) NOT NULL ,
		[state] [nvarchar] (10) NOT NULL CONSTRAINT [DF_export_job_state] DEFAULT (N'queued') ,
		[requested_by_id] [char] (35) NOT NULL ,
		[created] [datetime] NOT NULL ,
		[started_at] [datetime] NULL ,
		[finished_at] [datetime] NULL ,
		[error] [nvarchar] (max) NULL ,
		[file_name] [nvarchar] (255) NULL ,
		[content_type] [nvarchar] (100) NULL ,
		[output] [varbinary] (max) NULL ,
		[output_sha256] [char] (64) NULL ,
		CONSTRAINT [PK_export_job] PRIMARY KEY CLUSTERED ([job_id])
	) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]
END
GO
