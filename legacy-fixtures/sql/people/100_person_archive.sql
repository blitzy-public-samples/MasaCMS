-- SYNTHETIC: people - no Masa equivalent; legacy oracle in legacy-fixtures/
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

-- Archive records of Masa persons, written by the people fixture module.
IF OBJECT_ID(N'[synthetic].[person_archive]', N'U') IS NULL
CREATE TABLE [synthetic].[person_archive] (
	[archive_id] [char] (35) NOT NULL ,
	[person_id] [char] (35) NOT NULL ,
	[siteID] [nvarchar] (50) NOT NULL ,
	[effective_from] [datetime] NOT NULL ,
	[archived_at] [datetime] NOT NULL ,
	[archived_by_id] [char] (35) NULL ,
	[archived_by] [nvarchar] (50) NULL ,
	CONSTRAINT [PK_person_archive] PRIMARY KEY CLUSTERED ([archive_id]) ,
	CONSTRAINT [UQ_person_archive_person_effective] UNIQUE ([person_id], [effective_from])
) ON [PRIMARY];
GO
