-- SYNTHETIC: timesheets - no Masa equivalent; legacy oracle in legacy-fixtures/
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

-- Timesheet-day transitions, loaded from the exported state machine.
IF OBJECT_ID(N'[synthetic].[timesheet_transition]', N'U') IS NULL
BEGIN
	CREATE TABLE [synthetic].[timesheet_transition] (
		[from_state] [nvarchar] (20) NOT NULL ,
		[action] [nvarchar] (30) NOT NULL ,
		[role] [nvarchar] (50) NOT NULL ,
		[outcome] [nvarchar] (15) NOT NULL ,
		[status] [nvarchar] (3) NOT NULL ,
		[to_state] [nvarchar] (20) NULL ,
		[new_version] [tinyint] NULL ,
		[error] [nvarchar] (50) NULL ,
		CONSTRAINT [PK_timesheet_transition] PRIMARY KEY CLUSTERED ([from_state], [action], [role])
	) ON [PRIMARY];
END
GO
