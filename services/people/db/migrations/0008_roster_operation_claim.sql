-- The recovery resolution that owns a roster operation: its random claim token, NULL while only the operation's request writes it.
ALTER TABLE people.roster_operation ADD COLUMN claimed_by text NULL;
