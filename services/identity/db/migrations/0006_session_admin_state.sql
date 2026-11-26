-- Admin session-scope values kept between requests, as JSON text like login_snapshot; NULL when the session stored none.
ALTER TABLE identity.session ADD COLUMN admin_state text;
