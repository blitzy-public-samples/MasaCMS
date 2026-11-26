-- JSON API feed text equality and order: Intl.Collator('en', { sensitivity: 'accent' }), with the normalization ECMA-402 requires.
CREATE COLLATION IF NOT EXISTS content.bean_feed_ci (provider = icu, locale = 'en-u-kk-true-ks-level2', deterministic = false);
