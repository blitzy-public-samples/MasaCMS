-- SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

-- Surveys owned by a site.
IF OBJECT_ID(N'[synthetic].[survey]', N'U') IS NULL
CREATE TABLE [synthetic].[survey] (
	[survey_id] [char] (35) NOT NULL CONSTRAINT [PK_survey] PRIMARY KEY CLUSTERED ,
	[siteID] [nvarchar] (25) NOT NULL ,
	[title] [nvarchar] (255) NOT NULL ,
	[status] [nvarchar] (20) NOT NULL CONSTRAINT [DF_survey_status] DEFAULT (N'DRAFT') ,
	[created] [datetime] NOT NULL ,
	[createdByID] [char] (35) NOT NULL ,
	[lastUpdate] [datetime] NULL ,
	[lastUpdateByID] [char] (35) NULL ,
	[launched_at] [datetime] NULL
) ON [PRIMARY]
GO

-- Launch schedule of a survey, at most one per survey.
IF OBJECT_ID(N'[synthetic].[survey_schedule]', N'U') IS NULL
CREATE TABLE [synthetic].[survey_schedule] (
	[schedule_id] [char] (35) NOT NULL CONSTRAINT [PK_survey_schedule] PRIMARY KEY CLUSTERED ,
	[survey_id] [char] (35) NOT NULL CONSTRAINT [UQ_survey_schedule_survey_id] UNIQUE ,
	[launch_at] [datetime] NOT NULL ,
	[schedule_version] [int] NOT NULL ,
	[task_name] [nvarchar] (100) NOT NULL ,
	[task_token_hash] [char] (64) NOT NULL ,
	[created] [datetime] NOT NULL
) ON [PRIMARY]
GO

-- Reminder tasks of a scheduled survey.
IF OBJECT_ID(N'[synthetic].[survey_reminder]', N'U') IS NULL
CREATE TABLE [synthetic].[survey_reminder] (
	[reminder_id] [char] (35) NOT NULL CONSTRAINT [PK_survey_reminder] PRIMARY KEY CLUSTERED ,
	[survey_id] [char] (35) NOT NULL ,
	[offset_minutes] [int] NOT NULL ,
	[remind_at] [datetime] NOT NULL ,
	[task_name] [nvarchar] (100) NOT NULL ,
	[task_token_hash] [char] (64) NOT NULL ,
	[sent_at] [datetime] NULL
) ON [PRIMARY]
GO

-- Sites, and optionally groups within them, that a survey targets.
IF OBJECT_ID(N'[synthetic].[survey_target]', N'U') IS NULL
CREATE TABLE [synthetic].[survey_target] (
	[target_id] [char] (35) NOT NULL CONSTRAINT [PK_survey_target] PRIMARY KEY CLUSTERED ,
	[survey_id] [char] (35) NOT NULL ,
	[siteID] [nvarchar] (25) NOT NULL ,
	[group_name] [nvarchar] (255) NULL ,
	[created] [datetime] NOT NULL ,
	CONSTRAINT [UQ_survey_target_survey_site_group] UNIQUE ([survey_id],[siteID],[group_name])
) ON [PRIMARY]
GO

-- Survey responses, kept under the survey site with the respondent site alongside.
IF OBJECT_ID(N'[synthetic].[survey_response]', N'U') IS NULL
CREATE TABLE [synthetic].[survey_response] (
	[response_id] [char] (35) NOT NULL CONSTRAINT [PK_survey_response] PRIMARY KEY CLUSTERED ,
	[survey_id] [char] (35) NOT NULL ,
	[siteID] [nvarchar] (25) NOT NULL ,
	[respondentSiteID] [nvarchar] (25) NOT NULL ,
	[respondent_user_id] [char] (35) NOT NULL ,
	[answers] [nvarchar] (max) NOT NULL ,
	[created] [datetime] NOT NULL
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]
GO
