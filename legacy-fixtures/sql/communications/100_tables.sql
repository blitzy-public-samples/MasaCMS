-- SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

-- Reusable message subject and body templates.
IF OBJECT_ID(N'[synthetic].[message_template]', N'U') IS NULL
CREATE TABLE [synthetic].[message_template] (
	[template_id] [char] (35) NOT NULL ,
	[siteID] [nvarchar] (25) NOT NULL ,
	[name] [nvarchar] (100) NOT NULL ,
	[subject] [nvarchar] (255) NOT NULL ,
	[body_text] [nvarchar] (max) NOT NULL ,
	[body_html] [nvarchar] (max) NOT NULL ,
	[created] [datetime] NOT NULL ,
	[lastUpdate] [datetime] NULL ,
	CONSTRAINT [PK_message_template] PRIMARY KEY CLUSTERED ([template_id])
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]
GO

-- Outbound messages with their current delivery state.
IF OBJECT_ID(N'[synthetic].[message]', N'U') IS NULL
CREATE TABLE [synthetic].[message] (
	[message_id] [char] (35) NOT NULL ,
	[siteID] [nvarchar] (25) NOT NULL ,
	[template_id] [char] (35) NULL ,
	[to_address] [nvarchar] (255) NOT NULL ,
	[from_address] [nvarchar] (255) NOT NULL ,
	[subject] [nvarchar] (255) NOT NULL ,
	[body_text] [nvarchar] (max) NOT NULL ,
	[body_html] [nvarchar] (max) NOT NULL ,
	[state] [nvarchar] (10) NOT NULL CONSTRAINT [DF_message_state] DEFAULT (N'queued') ,
	[created] [datetime] NOT NULL ,
	[sent_at] [datetime] NULL ,
	CONSTRAINT [PK_message] PRIMARY KEY CLUSTERED ([message_id])
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]
GO

-- Append-only delivery status history per message.
IF OBJECT_ID(N'[synthetic].[delivery_status]', N'U') IS NULL
CREATE TABLE [synthetic].[delivery_status] (
	[status_id] [char] (35) NOT NULL ,
	[message_id] [char] (35) NOT NULL ,
	[status] [nvarchar] (10) NOT NULL ,
	[detail] [nvarchar] (max) NULL ,
	[mailpit_id] [nvarchar] (100) NULL ,
	[recorded_at] [datetime] NOT NULL ,
	CONSTRAINT [PK_delivery_status] PRIMARY KEY CLUSTERED ([status_id])
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]
GO
