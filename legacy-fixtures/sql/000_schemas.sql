-- SYNTHETIC: legacy-fixtures - no Masa equivalent; legacy oracle in legacy-fixtures/
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

-- Fixture SQL relies on OPENJSON and STRING_SPLIT.
IF (SELECT [compatibility_level] FROM sys.databases WHERE [database_id] = DB_ID()) < 130
    THROW 50000, N'legacy-fixtures: database compatibility level 130 or higher is required (OPENJSON, STRING_SPLIT).', 1;
GO

-- Fixture schemas.
IF SCHEMA_ID(N'synthetic') IS NULL EXEC(N'CREATE SCHEMA [synthetic]');
GO

IF SCHEMA_ID(N'Program_1') IS NULL EXEC(N'CREATE SCHEMA [Program_1]');
GO

IF SCHEMA_ID(N'Program_2') IS NULL EXEC(N'CREATE SCHEMA [Program_2]');
GO
