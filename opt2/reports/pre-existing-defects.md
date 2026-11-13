# Pre-existing legacy defects

Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f
Status: authored (planning); run findings appended by harness/src/golden/compare.ts

None of these is fixed: the target reproduces each one on carried routes (AAP 0.2.2, 0.11.1).

## Known issues

| ID | Issue | Location | Target behaviour | Parity |
|---|---|---|---|---|
| KI-01 | Admin date mask shows `10/302/2026` | `core/mura/resourceBundle/utils.cfc:363-371,379`: the en-US mask is built as `MM/DD/YYYY`, and ACF 2023 renders `DD` as day of year (the admin's `dtExample` reads `11/315/2024` for 2024-11-10). The masked field is recorded in `harness/golden/normalise.yaml` | Reproduced as legacy shows it | Masked at the date-mask field; `known-issue`, not counted |
| KI-02 | Session id not rotated at login | `core/mura/user/userUtility.cfc:382-387`: `sessionRotate()` runs only when `rotateSessions` is set (default `false`) | Reproduced as legacy shows it | Masked on the session cookie value across login; `known-issue`, not counted |
| KI-03 | Header search box posts to a route that returns 404 | `admin/common/layouts/includes/header.cfm:160-172`: form `globalSearch` (`action="#"`, `method="get"`, `muraAction=cArch.list`) | Reproduced as legacy shows it | Masked on the form action and its 404; `known-issue`, not counted |
| KI-04 | Group and user forms default to Member | `admin/core/controllers/cusers.cfc:228-230,249-251` (`tempIsPublic` from the bean's `isPublic`, default `1` at `core/mura/user/userBean.cfc:102,154`); `admin/core/views/cusers/editgroup.cfm:128,214-218`; `admin/core/views/cusers/edituser.cfm:495-500` | Reproduced as legacy shows it | Masked on the default type selection; `known-issue`, not counted |

No exceptions entry: the request exempts these four from the proposed-difference process.

## Security weaknesses

| ID | Weakness | Location | Route disposition | Recommendation |
|---|---|---|---|---|
| SEC-01 | Approval action skips CSRF: `true or rc.$.validateCSRFTokens(…)` short-circuits | `admin/core/views/carch/approvalaction.cfm:1-2` | carry (`carch`, strategies-content) | Fix recommended, deferred until after cut-over |
| SEC-02 | `cChangesets.publish` has no CSRF check, unlike `rollback` (line 150) | `admin/core/controllers/cchangesets.cfc:144-147` | carry (`cchangesets`, strategies-content) | Fix recommended, deferred until after cut-over |
| SEC-03 | JSON API ignores the site's `JSONApi` flag (default `0`, `core/mura/settings/settingsBean.cfc:163`): `apiEnabled` is hard-coded `true` | `core/mura/client/api/json/v1/jsonApiUtility.cfc:400` (checked at 871, 926) | carry (JSON API, per entity owner) | Fix recommended, deferred until after cut-over |
| SEC-04 | Unauthenticated `?appreload` re-runs application start-up | `core/appcfc/onApplicationStart_include.cfm:80,99`; `core/appcfc/onRequestStart_include.cfm:123-130` | `legacy-write` in every version | Open fix entry `EX-SEC-APPRELOAD` in [exceptions-list.md](../exceptions-list.md) (`decision: fix`, `status: open`) |
| SEC-05 | Unauthenticated `/_api/sitemonitor` runs every monitor step | `core/mura/content/contentServer.cfc:601,669-747` | carry (programs-sites orchestrator from `v0002`) | Fix recommended, deferred until after cut-over |
| SEC-06 | Session id not rotated at login | See KI-02 | — | Handled as known issue KI-02 |
| SEC-07 | JSON API site `findQuery` with `distinct=true` returns every `tsettings` column, `MailServerPassword`, `MailServerUsername`, `reCAPTCHASecret`, `reCAPTCHASiteKey` and `googleAPIKey` included, to anonymous callers of `/_api/json` and `/_api/ajax` (`/_api/rest` needs credentials): the distinct iterator's entity is `bean`, so no site field list filters the values. `findAll` and `findMany` with `distinct=true` keep the site field list and leak nothing | `core/mura/client/api/json/v1/jsonApiUtility.cfc:3118-3119` (`setDistinct`), `2920-2953` (`iteratorToArray` takes the field list from the iterator's entity) | carry (`api:site.findquery`, `rest:site.findquery`, programs-sites); `legacy` in every cut-over version | Fix recommended, deferred until after cut-over. The target answers the legacy-shaped 503 for a distinct `findQuery`: open `preserve` entry `EX-SITE-FEED-SUBFORMS` in [exceptions-list.md](../exceptions-list.md) |

An open `fix` entry would hold its carried route on legacy (AAP 0.4.2, 0.7.5), so only `?appreload`, which never cuts over, has one; carried routes declare `config.opt2.public: true` or the exact legacy role, keeping deny-by-default explicit.

## Other defects

| ID | Defect | Location | Note |
|---|---|---|---|
| OD-01 | Bounce-collection mail-server dedupe is ineffective: the `listAppend` result is discarded, so bounces are collected once per broadcasting site even when sites share a mail account | `core/mura/content/contentServer.cfc:692-694` | Reproduced by `services/programs-sites/src/jobs/sitemonitor.ts` |
| OD-02 | 21 baseline spec failures: 19 `entities`, 1 `beanFeedSecurity` timing, 1 `utility` Lucee-specific | See [baseline.md](baseline.md) | Not fixed; specs unchanged |
| OD-03 | `bundleValidatorSecurity.cfc` does not compile on ACF: `directoryCreate` with two arguments | `core/tests/specs/mura/core/bundleValidatorSecurity.cfc:36` | Official runner answers HTTP 500 with 0 specs; see [baseline.md](baseline.md) |
