-- The order and equality the JSON API group feeds compare text by, as V8's localeCompare('en', { sensitivity: 'accent' }) does:
-- ICU at secondary strength (case ignored, accents kept) with normalization on.
CREATE COLLATION identity.legacy_feed_ci (provider = icu, locale = 'en-u-kk-true-ks-level2', deterministic = false);
