-- Target dataids: negative, so they never meet legacy's or other owners' positive ids of the split IDENTITY column, nor move its seed;
-- ascending by 1 like IDENTITY(1,1), so a later row's id is greater than every earlier one.
CREATE SEQUENCE programs_sites.extend_data_dataid_seq AS integer
  INCREMENT BY 1 MINVALUE -2147483648 MAXVALUE -1 START WITH -2147483648
  OWNED BY programs_sites.extend_data.dataid;
