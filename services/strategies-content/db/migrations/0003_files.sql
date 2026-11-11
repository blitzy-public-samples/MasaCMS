-- strategies-content file, file metadata and stored-object manifest tables; columns, nullability and constant defaults follow the live legacy catalog, with varchar and nvarchar mapped to text by the canonical type map.
CREATE TABLE content.file (
  tenant_id uuid NOT NULL,
  fileid char(35) NOT NULL,
  contentid char(35),
  siteid text,
  moduleid char(35),
  filename text,
  image bytea,
  imagesmall bytea,
  imagemedium bytea,
  filesize integer,
  contenttype text,
  contentsubtype text,
  fileext text,
  created timestamp(3) without time zone,
  deleted smallint,
  caption text,
  credits text,
  alttext text,
  remoteid text,
  remoteurl text,
  remotepubdate timestamp(3) without time zone,
  remotesource text,
  remotesourceurl text,
  exif text,
  PRIMARY KEY (tenant_id, fileid)
);
ALTER TABLE content.file ENABLE ROW LEVEL SECURITY; ALTER TABLE content.file FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON content.file
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX file_tenant_contentid_idx ON content.file (tenant_id, contentid);

CREATE TABLE content.file_metadata (
  tenant_id uuid NOT NULL,
  alttext text,
  contenthistid char(35) DEFAULT '',
  fileid char(35) DEFAULT '',
  credits text,
  siteid text DEFAULT '',
  remoteurl text,
  exif text,
  remoteid text,
  remotesourceurl text,
  remotesource text,
  remotepubdate timestamp(3) without time zone,
  metaid char(35) NOT NULL DEFAULT '',
  contentid char(35) DEFAULT '',
  caption text,
  PRIMARY KEY (tenant_id, metaid)
);
ALTER TABLE content.file_metadata ENABLE ROW LEVEL SECURITY; ALTER TABLE content.file_metadata FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON content.file_metadata
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX file_metadata_tenant_fileid_idx ON content.file_metadata (tenant_id, fileid);
CREATE INDEX file_metadata_tenant_contenthistid_idx ON content.file_metadata (tenant_id, contenthistid);

CREATE TABLE content.file_object (
  tenant_id uuid NOT NULL,
  file_id char(35) NOT NULL,
  variant text NOT NULL,
  ext text NOT NULL,
  object_key text NOT NULL,
  size bigint NOT NULL,
  sha256 char(64) NOT NULL,
  content_type text,
  orphan boolean NOT NULL DEFAULT false,
  created_at timestamp(3) without time zone NOT NULL,
  PRIMARY KEY (tenant_id, object_key)
);
ALTER TABLE content.file_object ENABLE ROW LEVEL SECURITY; ALTER TABLE content.file_object FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON content.file_object
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX file_object_tenant_file_id_idx ON content.file_object (tenant_id, file_id);
