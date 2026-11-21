-- SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
SET ANSI_NULLS ON; SET QUOTED_IDENTIFIER ON;
GO

-- Finance lifecycle transitions, loaded from the exported state machine.
IF OBJECT_ID(N'[synthetic].[finance_transition]', N'U') IS NULL
BEGIN
	CREATE TABLE [synthetic].[finance_transition] (
		[from_state] [nvarchar] (20) NOT NULL ,
		[action] [nvarchar] (30) NOT NULL ,
		[role] [nvarchar] (50) NOT NULL ,
		[outcome] [nvarchar] (15) NOT NULL ,
		[status] [nvarchar] (3) NOT NULL ,
		[to_state] [nvarchar] (20) NULL ,
		[new_version] [tinyint] NULL ,
		[error] [nvarchar] (50) NULL ,
		CONSTRAINT [PK_finance_transition] PRIMARY KEY CLUSTERED ([from_state], [action], [role])
	) ON [PRIMARY];
END
GO
