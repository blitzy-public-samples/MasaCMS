-- Target ids of group tags and group extended data, which share one legacy IDENTITY column with people's rows of the same tables.
-- Descending negative values never meet legacy's positive IDENTITY values or people's ascending sequences, and an explicit
-- insert below SQL Server's current identity value leaves its seed unchanged, so legacy inserts keep their own numbering.
CREATE SEQUENCE identity.user_tag_tagid_seq AS integer
  INCREMENT BY -1 MINVALUE -2147483648 MAXVALUE -1 START WITH -1
  OWNED BY identity.user_tag.tagid;
CREATE SEQUENCE identity.extend_data_user_activity_dataid_seq AS integer
  INCREMENT BY -1 MINVALUE -2147483648 MAXVALUE -1 START WITH -1
  OWNED BY identity.extend_data_user_activity.dataid;
