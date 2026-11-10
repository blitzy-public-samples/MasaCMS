-- SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

-- One timesheet per person and period.
IF OBJECT_ID(N'[$(PROGRAM_SCHEMA)].[timesheet]', N'U') IS NULL
BEGIN
	CREATE TABLE [$(PROGRAM_SCHEMA)].[timesheet] (
		[timesheet_id] [char] (35) NOT NULL ,
		[person_id] [char] (35) NOT NULL ,
		[siteID] [nvarchar] (25) NOT NULL ,
		[period_start] [datetime] NOT NULL ,
		[period_end] [datetime] NOT NULL ,
		[due_date] [datetime] NOT NULL ,
		[created] [datetime] NOT NULL ,
		[lastUpdate] [datetime] NULL ,
		[lastUpdateByID] [char] (35) NULL ,
		CONSTRAINT [PK_timesheet] PRIMARY KEY CLUSTERED ([timesheet_id])
	) ON [PRIMARY];
END
GO

-- One work day of a timesheet with its lifecycle state.
IF OBJECT_ID(N'[$(PROGRAM_SCHEMA)].[timesheet_day]', N'U') IS NULL
BEGIN
	CREATE TABLE [$(PROGRAM_SCHEMA)].[timesheet_day] (
		[day_id] [char] (35) NOT NULL ,
		[timesheet_id] [char] (35) NOT NULL ,
		[work_date] [datetime] NOT NULL ,
		[hours] [numeric] (19, 4) NOT NULL ,
		[state] [nvarchar] (20) NOT NULL CONSTRAINT [DF_timesheet_day_state] DEFAULT (N'DRAFT') ,
		[lastUpdate] [datetime] NULL ,
		[lastUpdateByID] [char] (35) NULL ,
		CONSTRAINT [PK_timesheet_day] PRIMARY KEY CLUSTERED ([day_id])
	) ON [PRIMARY];
END
GO

-- Audit row of each applied day transition.
IF OBJECT_ID(N'[$(PROGRAM_SCHEMA)].[approval_action]', N'U') IS NULL
BEGIN
	CREATE TABLE [$(PROGRAM_SCHEMA)].[approval_action] (
		[action_id] [char] (35) NOT NULL ,
		[day_id] [char] (35) NOT NULL ,
		[action] [nvarchar] (30) NOT NULL ,
		[role] [nvarchar] (50) NOT NULL ,
		[from_state] [nvarchar] (20) NOT NULL ,
		[to_state] [nvarchar] (20) NOT NULL ,
		[actor_user_id] [char] (35) NOT NULL ,
		[comment] [nvarchar] (max) NULL ,
		[created] [datetime] NOT NULL ,
		CONSTRAINT [PK_approval_action] PRIMARY KEY CLUSTERED ([action_id])
	) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY];
END
GO

-- Timesheet day closed by a person archive.
IF OBJECT_ID(N'[$(PROGRAM_SCHEMA)].[blackout]', N'U') IS NULL
BEGIN
	CREATE TABLE [$(PROGRAM_SCHEMA)].[blackout] (
		[blackout_id] [char] (35) NOT NULL ,
		[day_id] [char] (35) NOT NULL CONSTRAINT [UQ_blackout_day_id] UNIQUE ,
		[person_id] [char] (35) NOT NULL ,
		[archive_id] [char] (35) NULL ,
		[reason] [nvarchar] (50) NOT NULL CONSTRAINT [DF_blackout_reason] DEFAULT (N'person-archived') ,
		[created] [datetime] NOT NULL ,
		CONSTRAINT [PK_blackout] PRIMARY KEY CLUSTERED ([blackout_id])
	) ON [PRIMARY];
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'[$(PROGRAM_SCHEMA)].[timesheet]') AND name = N'IX_timesheet_person_id')
	CREATE NONCLUSTERED INDEX [IX_timesheet_person_id] ON [$(PROGRAM_SCHEMA)].[timesheet]([person_id]) ON [PRIMARY];
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'[$(PROGRAM_SCHEMA)].[timesheet_day]') AND name = N'IX_timesheet_day_timesheet_id')
	CREATE NONCLUSTERED INDEX [IX_timesheet_day_timesheet_id] ON [$(PROGRAM_SCHEMA)].[timesheet_day]([timesheet_id]) ON [PRIMARY];
GO
