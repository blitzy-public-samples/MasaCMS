-- SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON;
GO

-- Finance record with its current lifecycle state and version.
IF OBJECT_ID(N'[$(PROGRAM_SCHEMA)].[finance_record]', N'U') IS NULL
BEGIN
	CREATE TABLE [$(PROGRAM_SCHEMA)].[finance_record] (
		[record_id] [char] (35) NOT NULL ,
		[siteID] [nvarchar] (25) NOT NULL ,
		[title] [nvarchar] (255) NOT NULL ,
		[amount] [numeric] (19, 4) NOT NULL ,
		[period] [nvarchar] (7) NOT NULL ,
		[state] [nvarchar] (20) NOT NULL CONSTRAINT [DF_finance_record_state] DEFAULT (N'IN-PROGRESS') ,
		[version] [int] NOT NULL CONSTRAINT [DF_finance_record_version] DEFAULT (1) ,
		[created] [datetime] NOT NULL ,
		[createdByID] [char] (35) NOT NULL ,
		[lastUpdate] [datetime] NULL ,
		[lastUpdateByID] [char] (35) NULL ,
		CONSTRAINT [PK_finance_record] PRIMARY KEY CLUSTERED ([record_id])
	) ON [PRIMARY];
END
GO

-- One row per create, edit and transition of a finance record.
IF OBJECT_ID(N'[$(PROGRAM_SCHEMA)].[finance_record_version]', N'U') IS NULL
BEGIN
	CREATE TABLE [$(PROGRAM_SCHEMA)].[finance_record_version] (
		[version_id] [char] (35) NOT NULL ,
		[record_id] [char] (35) NOT NULL ,
		[version] [int] NOT NULL ,
		[state] [nvarchar] (20) NOT NULL ,
		[title] [nvarchar] (255) NOT NULL ,
		[amount] [numeric] (19, 4) NOT NULL ,
		[period] [nvarchar] (7) NOT NULL ,
		[action] [nvarchar] (30) NOT NULL ,
		[actor_user_id] [char] (35) NOT NULL ,
		[created] [datetime] NOT NULL ,
		CONSTRAINT [PK_finance_record_version] PRIMARY KEY CLUSTERED ([version_id]) ,
		CONSTRAINT [UQ_finance_record_version_record_version] UNIQUE ([record_id],[version])
	) ON [PRIMARY];
END
GO

-- Attachment bytes for a finance record.
IF OBJECT_ID(N'[$(PROGRAM_SCHEMA)].[finance_attachment]', N'U') IS NULL
BEGIN
	CREATE TABLE [$(PROGRAM_SCHEMA)].[finance_attachment] (
		[attachment_id] [char] (35) NOT NULL ,
		[record_id] [char] (35) NOT NULL ,
		[file_name] [nvarchar] (255) NOT NULL ,
		[content_type] [nvarchar] (100) NOT NULL ,
		[size_bytes] [int] NOT NULL ,
		[sha256] [char] (64) NOT NULL ,
		[content] [varbinary] (max) NOT NULL ,
		[created] [datetime] NOT NULL ,
		[createdByID] [char] (35) NOT NULL ,
		CONSTRAINT [PK_finance_attachment] PRIMARY KEY CLUSTERED ([attachment_id])
	) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY];
END
GO

-- Record count and total amount per period and state.
IF OBJECT_ID(N'[$(PROGRAM_SCHEMA)].[finance_rollup]', N'U') IS NULL
BEGIN
	CREATE TABLE [$(PROGRAM_SCHEMA)].[finance_rollup] (
		[period] [nvarchar] (7) NOT NULL ,
		[state] [nvarchar] (20) NOT NULL ,
		[record_count] [int] NOT NULL ,
		[total_amount] [numeric] (19, 4) NOT NULL ,
		[computed_at] [datetime] NOT NULL ,
		CONSTRAINT [PK_finance_rollup] PRIMARY KEY CLUSTERED ([period],[state])
	) ON [PRIMARY];
END
GO
