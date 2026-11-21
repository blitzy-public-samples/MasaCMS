-- SYNTHETIC: esignature - no Masa equivalent; legacy oracle in legacy-fixtures/
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

-- Document awaiting one signer's typed-name signature.
IF OBJECT_ID(N'[synthetic].[signature_request]', N'U') IS NULL
BEGIN
CREATE TABLE [synthetic].[signature_request] (
	[request_id] [char] (35) NOT NULL ,
	[siteID] [nvarchar] (25) NOT NULL ,
	[document_name] [nvarchar] (255) NOT NULL ,
	[document_sha256] [char] (64) NOT NULL ,
	[document] [varbinary] (max) NULL ,
	[signer_user_id] [char] (35) NOT NULL ,
	[state] [nvarchar] (10) NOT NULL CONSTRAINT [DF_signature_request_state] DEFAULT (N'PENDING') ,
	[created] [datetime] NOT NULL ,
	[createdByID] [char] (35) NOT NULL ,
	CONSTRAINT [PK_signature_request] PRIMARY KEY CLUSTERED ([request_id])
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY];
END
GO

-- Typed-name signature of a request, at most one per request.
IF OBJECT_ID(N'[synthetic].[signature]', N'U') IS NULL
BEGIN
CREATE TABLE [synthetic].[signature] (
	[signature_id] [char] (35) NOT NULL ,
	[request_id] [char] (35) NOT NULL ,
	[typed_name] [nvarchar] (255) NOT NULL ,
	[signer_user_id] [char] (35) NOT NULL ,
	[signed_at] [datetime] NOT NULL ,
	CONSTRAINT [PK_signature] PRIMARY KEY CLUSTERED ([signature_id]) ,
	CONSTRAINT [UQ_signature_request_id] UNIQUE ([request_id])
) ON [PRIMARY];
END
GO

-- Append-only SHA-256 hash-chained audit entry of a request.
IF OBJECT_ID(N'[synthetic].[audit_entry]', N'U') IS NULL
BEGIN
CREATE TABLE [synthetic].[audit_entry] (
	[entry_id] [char] (35) NOT NULL ,
	[request_id] [char] (35) NOT NULL ,
	[seq] [int] NOT NULL ,
	[action] [nvarchar] (30) NOT NULL ,
	[actor_user_id] [char] (35) NULL ,
	[detail] [nvarchar] (max) NULL ,
	[at] [datetime] NOT NULL ,
	[prev_hash] [binary] (32) NOT NULL ,
	[entry_hash] [binary] (32) NOT NULL ,
	CONSTRAINT [PK_audit_entry] PRIMARY KEY CLUSTERED ([entry_id]) ,
	CONSTRAINT [UQ_audit_entry_request_seq] UNIQUE ([request_id],[seq])
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY];
END
GO
