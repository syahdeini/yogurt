-- Preferred by Nature pilot. Run as a Microsoft Entra admin of the EXISTING database
-- on sql-external-landing-pbn (resource group rg-dat-bui-asana). This script does not
-- create a server or a database, and nothing in rg-yogurt-pilot writes to that resource group.
-- Re-running keeps the tables, adds any missing columns, and replaces the row-level security policy.

IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = N'notes') EXEC(N'CREATE SCHEMA notes');
GO

IF OBJECT_ID(N'notes.meetings', N'U') IS NULL
CREATE TABLE notes.meetings (
  id UNIQUEIDENTIFIER NOT NULL CONSTRAINT pk_meetings PRIMARY KEY,
  user_oid NVARCHAR(64) NOT NULL,
  local_id NVARCHAR(64) NOT NULL,
  title NVARCHAR(400) NULL,
  status NVARCHAR(32) NOT NULL CONSTRAINT ck_meetings_status CHECK (status IN (N'uploaded', N'transcribing', N'summarizing', N'ready', N'failed')),
  tracks NVARCHAR(MAX) NOT NULL,
  language NVARCHAR(32) NULL,
  error NVARCHAR(2000) NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT df_meetings_created DEFAULT SYSUTCDATETIME(),
  updated_at DATETIME2 NOT NULL CONSTRAINT df_meetings_updated DEFAULT SYSUTCDATETIME(),
  CONSTRAINT uq_meetings_user_local UNIQUE (user_oid, local_id)
);
GO

IF OBJECT_ID(N'notes.transcripts', N'U') IS NULL
CREATE TABLE notes.transcripts (
  meeting_id UNIQUEIDENTIFIER NOT NULL CONSTRAINT pk_transcripts PRIMARY KEY,
  user_oid NVARCHAR(64) NOT NULL,
  content NVARCHAR(MAX) NOT NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT df_transcripts_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT fk_transcripts_meeting FOREIGN KEY (meeting_id) REFERENCES notes.meetings(id)
);
GO

IF OBJECT_ID(N'notes.summaries', N'U') IS NULL
CREATE TABLE notes.summaries (
  meeting_id UNIQUEIDENTIFIER NOT NULL CONSTRAINT pk_summaries PRIMARY KEY,
  user_oid NVARCHAR(64) NOT NULL,
  model NVARCHAR(64) NOT NULL,
  markdown NVARCHAR(MAX) NOT NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT df_summaries_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT fk_summaries_meeting FOREIGN KEY (meeting_id) REFERENCES notes.meetings(id)
);
GO

IF OBJECT_ID(N'notes.action_items', N'U') IS NULL
CREATE TABLE notes.action_items (
  id UNIQUEIDENTIFIER NOT NULL CONSTRAINT pk_action_items PRIMARY KEY,
  meeting_id UNIQUEIDENTIFIER NOT NULL,
  user_oid NVARCHAR(64) NOT NULL,
  owner NVARCHAR(200) NULL,
  text NVARCHAR(2000) NOT NULL,
  due NVARCHAR(200) NULL,
  CONSTRAINT fk_action_items_meeting FOREIGN KEY (meeting_id) REFERENCES notes.meetings(id)
);
GO

-- Drop the policy first so the column changes below never meet a schema-bound policy. It is recreated below.
IF EXISTS (SELECT 1 FROM sys.security_policies WHERE name = N'meeting_isolation' AND schema_id = SCHEMA_ID(N'notes'))
  DROP SECURITY POLICY notes.meeting_isolation;
GO

-- Worker lease (one worker per meeting at a time) and the summary retry count. Added separately so
-- re-running upgrades a database that already has the first version of notes.meetings.
IF COL_LENGTH(N'notes.meetings', N'lease_until') IS NULL
  ALTER TABLE notes.meetings ADD lease_until DATETIME2 NULL;
GO
IF COL_LENGTH(N'notes.meetings', N'attempts') IS NULL
  ALTER TABLE notes.meetings ADD attempts INT NOT NULL CONSTRAINT df_meetings_attempts DEFAULT 0;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'ix_meetings_status' AND object_id = OBJECT_ID(N'notes.meetings'))
  CREATE INDEX ix_meetings_status ON notes.meetings(status);
GO

-- The function's managed identity is one database user, in role notes_app. HTTP calls set SESSION_CONTEXT
-- user_oid and clear bypass. The timer sets bypass = worker so it can finish every meeting, then still writes
-- each row with that meeting's user_oid.
-- Anyone can call sp_set_session_context, so the predicate also requires membership of notes_app. Other users
-- of this database (analysts with db_datareader, for example) see no rows in notes, whatever they set.
-- db_owner members can still drop or alter this policy, so keep owners of this database to the people who
-- are allowed to read meeting transcripts.

CREATE OR ALTER FUNCTION notes.fn_user_filter(@user_oid NVARCHAR(64))
RETURNS TABLE
WITH SCHEMABINDING
AS
RETURN
  SELECT 1 AS allow_row
  WHERE IS_ROLEMEMBER(N'notes_app') = 1
    AND (CONVERT(NVARCHAR(64), SESSION_CONTEXT(N'user_oid')) = @user_oid
      OR CONVERT(NVARCHAR(10), SESSION_CONTEXT(N'bypass')) = N'worker');
GO

CREATE SECURITY POLICY notes.meeting_isolation
  ADD FILTER PREDICATE notes.fn_user_filter(user_oid) ON notes.meetings,
  ADD BLOCK PREDICATE notes.fn_user_filter(user_oid) ON notes.meetings,
  ADD FILTER PREDICATE notes.fn_user_filter(user_oid) ON notes.transcripts,
  ADD BLOCK PREDICATE notes.fn_user_filter(user_oid) ON notes.transcripts,
  ADD FILTER PREDICATE notes.fn_user_filter(user_oid) ON notes.summaries,
  ADD BLOCK PREDICATE notes.fn_user_filter(user_oid) ON notes.summaries,
  ADD FILTER PREDICATE notes.fn_user_filter(user_oid) ON notes.action_items,
  ADD BLOCK PREDICATE notes.fn_user_filter(user_oid) ON notes.action_items
  WITH (STATE = ON);
GO

IF DATABASE_PRINCIPAL_ID(N'notes_app') IS NULL CREATE ROLE notes_app;
GO

GRANT SELECT, INSERT, UPDATE, DELETE ON notes.meetings TO notes_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON notes.transcripts TO notes_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON notes.summaries TO notes_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON notes.action_items TO notes_app;
GO

-- After cloud/deploy.ps1 prints the function app name, connect to this database and run,
-- replacing the name (the deploy script prints the finished statements):
--   CREATE USER [func-yogurt-pilot] FROM EXTERNAL PROVIDER;
--   ALTER ROLE notes_app ADD MEMBER [func-yogurt-pilot];
-- Do not add the function to db_owner. Owners can switch row-level security off.
-- Also allow Azure services through the server firewall. This script does not change it.
