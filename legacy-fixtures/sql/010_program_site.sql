-- SYNTHETIC: legacy-fixtures - no Masa equivalent; legacy oracle in legacy-fixtures/
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

-- Maps each fixture program schema Program_<id> to its Masa site.
IF OBJECT_ID(N'[synthetic].[program_site]', N'U') IS NULL
CREATE TABLE [synthetic].[program_site] (
    [program_id] [int] NOT NULL ,
    [siteID] [nvarchar] (25) NOT NULL ,
    CONSTRAINT [PK_program_site] PRIMARY KEY CLUSTERED ([program_id]) ,
    CONSTRAINT [UQ_program_site_siteID] UNIQUE ([siteID])
) ON [PRIMARY];
GO

INSERT INTO [synthetic].[program_site] ([program_id], [siteID])
SELECT [v].[program_id], [v].[siteID]
FROM (VALUES (1, N'tenant-a'), (2, N'tenant-b')) AS [v] ([program_id], [siteID])
WHERE NOT EXISTS (
    SELECT 1 FROM [synthetic].[program_site] AS [ps] WHERE [ps].[program_id] = [v].[program_id]
);
GO
