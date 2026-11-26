-- Bootstrap DDL sample in the core/setup/db/mssql.sql style
CREATE TABLE [dbo].[tfixture] (
	[fixtureID] [char] (35) NOT NULL ,
	[SiteID] [nvarchar] (25) NULL ,
	[userID] [char] (35) NULL ,
	[name] [nvarchar] (100) NULL
) ON [PRIMARY]
GO

CREATE TABLE [dbo].[tfixturenopk] (
	[fixtureID] [char] (35) NULL ,
	[label] [nvarchar] (50) NULL
) ON [PRIMARY]
GO

CREATE TABLE [dbo].[tfixturestats] (
	[statID] [char] (35) NOT NULL ,
	[siteid] [nvarchar] (25) NULL ,
	[data] [ntext] NULL
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]
GO

ALTER TABLE [dbo].[tfixture] WITH NOCHECK ADD
	CONSTRAINT [PK_tfixture] PRIMARY KEY  CLUSTERED
	(
		[fixtureID]
	)  ON [PRIMARY]
GO

ALTER TABLE [dbo].[tfixturestats] WITH NOCHECK ADD
	CONSTRAINT [PK_tfixturestats] PRIMARY KEY  CLUSTERED
	(
		[statID]
	)  ON [PRIMARY]
GO
