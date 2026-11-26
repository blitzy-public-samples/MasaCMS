-- CSRF secret as text, so an adopted legacy secret of any length is kept exactly; the cast drops the char(35) padding of stored rows.
ALTER TABLE identity.session ALTER COLUMN csrf_secret TYPE text;
