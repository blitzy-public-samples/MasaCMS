-- Target values of the IDENTITY columns legacy also numbers: negative, so they never meet the positive values backfill copies or
-- legacy-served writers keep issuing, nor move SQL Server's seed when projected back; ascending by 1 like IDENTITY(1,1).
-- Each range is set once, while its sequence maximum is not yet -1, so a re-run never restarts issued values.
DO $$
BEGIN
  IF (SELECT seqmax FROM pg_sequence WHERE seqrelid = pg_get_serial_sequence('content.content', 'tcontent_id')::regclass) <> -1 THEN
    ALTER TABLE content.content ALTER COLUMN tcontent_id
      SET MINVALUE -2147483648 SET MAXVALUE -1 SET START WITH -2147483648 RESTART WITH -2147483648;
  END IF;
  IF (SELECT seqmax FROM pg_sequence WHERE seqrelid = pg_get_serial_sequence('content.content_related', 'relatedcontentid')::regclass) <> -1 THEN
    ALTER TABLE content.content_related ALTER COLUMN relatedcontentid
      SET MINVALUE -2147483648 SET MAXVALUE -1 SET START WITH -2147483648 RESTART WITH -2147483648;
  END IF;
  IF (SELECT seqmax FROM pg_sequence WHERE seqrelid = pg_get_serial_sequence('content.content_tag', 'tagid')::regclass) <> -1 THEN
    ALTER TABLE content.content_tag ALTER COLUMN tagid
      SET MINVALUE -2147483648 SET MAXVALUE -1 SET START WITH -2147483648 RESTART WITH -2147483648;
  END IF;
  IF (SELECT seqmax FROM pg_sequence WHERE seqrelid = pg_get_serial_sequence('content.extend_attribute', 'attributeid')::regclass) <> -1 THEN
    ALTER TABLE content.extend_attribute ALTER COLUMN attributeid
      SET MINVALUE -2147483648 SET MAXVALUE -1 SET START WITH -2147483648 RESTART WITH -2147483648;
  END IF;
  IF (SELECT seqmax FROM pg_sequence WHERE seqrelid = pg_get_serial_sequence('content.extend_data', 'dataid')::regclass) <> -1 THEN
    ALTER TABLE content.extend_data ALTER COLUMN dataid
      SET MINVALUE -2147483648 SET MAXVALUE -1 SET START WITH -2147483648 RESTART WITH -2147483648;
  END IF;
END
$$;
